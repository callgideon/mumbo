/**
 * One stack per environment (`-c env=dev|prod`), account gideon, us-east-1:
 * CloudFront -> ALB (HTTPS) -> Fargate `dsh web` with EFS at /data. Static assets are not separable
 * from the server (same origin), so the CDN fronts the whole app. CodeBuild builds deploy/Dockerfile on push.
 *
 * Domains: dev serves dev.app / dev.api.mumbo.si. prod keeps app / api.mumbo.si OFF until
 * `-c attach=true`, because those names are live on the jumbo CloudFront distribution today
 * (an alias can live on one distribution only, and the ACM validation records already exist).
 */
import * as cdk from 'aws-cdk-lib'
import { aws_certificatemanager as acm, aws_cloudfront as cf, aws_cloudfront_origins as origins, aws_codebuild as cb, aws_ec2 as ec2, aws_ecr as ecr, aws_ecs as ecs, aws_efs as efs, aws_elasticloadbalancingv2 as elb, aws_iam as iam, aws_route53 as r53, aws_route53_targets as targets, aws_s3 as s3, aws_secretsmanager as sm } from 'aws-cdk-lib'

const app = new cdk.App()
const env = app.node.tryGetContext('env') as 'dev' | 'prod'
if (env !== 'dev' && env !== 'prod') throw new Error('pass -c env=dev|prod')
const removal = env === 'dev' ? cdk.RemovalPolicy.DESTROY : cdk.RemovalPolicy.RETAIN
const attach = env === 'dev' || app.node.tryGetContext('attach') === 'true'
const branch = env === 'prod' ? 'main' : 'dev'
const zoneName = 'mumbo.si'
const appHost = env === 'prod' ? 'app.mumbo.si' : 'dev.app.mumbo.si'
const apiHost = env === 'prod' ? 'api.mumbo.si' : 'dev.api.mumbo.si'
const originHost = `origin-${env}.mumbo.si`

const stack = new cdk.Stack(app, `mumbo-${env}`, { env: { account: '641134885443', region: 'us-east-1' } })
const zone = r53.HostedZone.fromHostedZoneAttributes(stack, 'Zone', { hostedZoneId: 'Z07707413UYOQHO5GVGN4', zoneName })
const vpc = ec2.Vpc.fromLookup(stack, 'Vpc', { isDefault: true })

const names = attach ? [appHost, apiHost, originHost] : [originHost]
const cert = new acm.Certificate(stack, 'Cert', { domainName: names[0]!, subjectAlternativeNames: names.slice(1), validation: acm.CertificateValidation.fromDns(zone) })

const repo = new ecr.Repository(stack, 'Repo', { repositoryName: `mumbo-web-${env}`, lifecycleRules: [{ maxImageCount: 20 }], removalPolicy: removal, emptyOnDelete: env === 'dev' })
const apiKey = new sm.Secret(stack, 'DeepseekKey', { secretName: `mumbo/${env}/deepseek-api-key`, description: 'Set the value after deploy' })
const fs = new efs.FileSystem(stack, 'Data', { vpc, encrypted: true, removalPolicy: removal })

const cluster = new ecs.Cluster(stack, 'Cluster', { vpc })
const task = new ecs.FargateTaskDefinition(stack, 'Task', { cpu: 2048, memoryLimitMiB: 8192 })
task.addVolume({ name: 'data', efsVolumeConfiguration: { fileSystemId: fs.fileSystemId, transitEncryption: 'ENABLED', authorizationConfig: { iam: 'ENABLED' } } })
const container = task.addContainer('web', {
  image: ecs.ContainerImage.fromEcrRepository(repo, env),
  logging: ecs.LogDrivers.awsLogs({ streamPrefix: 'web' }),
  portMappings: [{ containerPort: 3080 }],
  environment: { MUMBO_PUBLIC_HOST: appHost, MUMBO_EXTRA_TRUSTED_HOST: apiHost, DEEPSEEK_BASE_URL: 'https://api.deepseek.com' },
  secrets: { DEEPSEEK_API_KEY: ecs.Secret.fromSecretsManager(apiKey) },
})
container.addMountPoints({ containerPath: '/data', sourceVolume: 'data', readOnly: false })
fs.grantRootAccess(task.taskRole)

const service = new ecs.FargateService(stack, 'Service', { cluster, taskDefinition: task, desiredCount: Number(app.node.tryGetContext('desired') ?? 1), assignPublicIp: true, minHealthyPercent: 0, maxHealthyPercent: 100 })
fs.connections.allowDefaultPortFrom(service)

const alb = new elb.ApplicationLoadBalancer(stack, 'Alb', { vpc, internetFacing: true, idleTimeout: cdk.Duration.seconds(300) })
const listener = alb.addListener('Https', { port: 443, certificates: [cert], open: true })
// The server answers 401 to unauthenticated requests, which proves it is up.
listener.addTargets('Web', { port: 3080, protocol: elb.ApplicationProtocol.HTTP, targets: [service], healthCheck: { path: '/', healthyHttpCodes: '200-499' } })
new r53.ARecord(stack, 'OriginRecord', { zone, recordName: originHost, target: r53.RecordTarget.fromAlias(new targets.LoadBalancerTarget(alb)) })

const dist = new cf.Distribution(stack, 'Cdn', {
  domainNames: attach ? [appHost, apiHost] : undefined,
  certificate: attach ? cert : undefined,
  priceClass: cf.PriceClass.PRICE_CLASS_200, // includes India (Mumbai) edge
  defaultBehavior: {
    origin: new origins.HttpOrigin(originHost, { protocolPolicy: cf.OriginProtocolPolicy.HTTPS_ONLY, readTimeout: cdk.Duration.seconds(60) }),
    viewerProtocolPolicy: cf.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
    allowedMethods: cf.AllowedMethods.ALLOW_ALL,
    cachePolicy: cf.CachePolicy.CACHING_DISABLED,
    originRequestPolicy: cf.OriginRequestPolicy.ALL_VIEWER, // forwards Host: the server fences on it
  },
})
if (attach) for (const h of [appHost, apiHost]) {
  const t = r53.RecordTarget.fromAlias(new targets.CloudFrontTarget(dist))
  new r53.ARecord(stack, `A-${h}`, { zone, recordName: h, target: t })
  new r53.AaaaRecord(stack, `AAAA-${h}`, { zone, recordName: h, target: t })
}

new s3.Bucket(stack, 'Downloads', { bucketName: `mumbo-downloads-${env}-641134885443`, blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL, encryption: s3.BucketEncryption.S3_MANAGED, removalPolicy: removal, autoDeleteObjects: env === 'dev' })

const build = new cb.Project(stack, 'Build', {
  projectName: `mumbo-${env}`,
  // ponytail: no webhook yet (the GitHub connection lacks repo-admin); start builds manually until it has.
  source: cb.Source.gitHub({ owner: 'callgideon', repo: 'mumbo', branchOrRef: branch }),
  buildSpec: cb.BuildSpec.fromSourceFilename('deploy/buildspec.yml'),
  environment: { buildImage: cb.LinuxBuildImage.STANDARD_7_0, computeType: cb.ComputeType.X_LARGE, privileged: true },
  timeout: cdk.Duration.minutes(60),
  environmentVariables: {
    ECR_REPO: { value: repo.repositoryUri }, ECS_CLUSTER: { value: cluster.clusterName },
    ECS_SERVICE: { value: service.serviceName }, MUMBO_ENV: { value: env },
  },
})
repo.grantPullPush(build)
build.addToRolePolicy(new iam.PolicyStatement({ actions: ['codeconnections:GetConnection', 'codeconnections:GetConnectionToken', 'codeconnections:UseConnection', 'codestar-connections:GetConnection', 'codestar-connections:GetConnectionToken', 'codestar-connections:UseConnection'], resources: ['arn:aws:codeconnections:us-east-1:641134885443:connection/*', 'arn:aws:codestar-connections:us-east-1:641134885443:connection/*'] }))
build.addToRolePolicy(new iam.PolicyStatement({ actions: ['ecs:UpdateService'], resources: [service.serviceArn] }))

new cdk.CfnOutput(stack, 'CloudFrontDomain', { value: dist.distributionDomainName })
