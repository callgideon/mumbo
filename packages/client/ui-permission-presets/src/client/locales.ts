/** `settings.permission` namespace dictionaries (the Permission row's copy). */

/** Locale namespace shared by both current-session permission pickers. */
export const PERMISSION_ACCESS_NS = 'permission.access'

/** The settings.permission namespace key union. */
export type PermissionSettingsKey = keyof typeof en

/** English dictionary (the key-set source of truth). */
export const en = {
  'title': 'Permission',
  'description': 'Choose the default permission mode for new sessions',
  'loading': 'Loading',
  'unavailable': 'Unavailable',
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access lets new sessions reduce confirmation steps and perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust subsequent tasks.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
  'runWild.confirm.title': 'Start new sessions in Run Wild?',
  'runWild.confirm.description': "New sessions will start in Run Wild, where Mumbo doesn't ask before it acts. It decides from context and your rules, then sends and posts as you, buys with saved payment methods, and deletes, and it logs each action. Still in place: it never types passwords or one-time codes, it stays off sign-in and card-entry pages, per-site limits apply, and merges, deploys and repository access still need your approval.",
  'runWild.confirm.acknowledge': 'I understand Mumbo will act without asking',
  'runWild.confirm.enable': 'Start in Run Wild',
} satisfies Record<string, string>

/** Current-session popup-gate key union. */
export type PermissionAccessKey = keyof typeof accessEn

/** English dictionary for the current-session popup gate. */
export const accessEn = {
  'mode': 'Access mode, current: {name}',
  'close': 'Close',
  'preset.readOnly': 'Read Only',
  'preset.workspaceWrite': 'Workspace Write',
  'preset.fullAccess': 'Full access',
  'confirm.title': 'Enable Full access?',
  'confirm.description': 'Full access reduces confirmation steps and lets the agent perform more actions directly, including sensitive operations, file changes, or external commands. Only use it when you trust the current task.',
  'confirm.acknowledge': 'I understand the risks and want to continue',
  'confirm.cancel': 'Cancel',
  'confirm.enable': 'Enable Full access',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Run without a sandbox after an experimental same-model review of every native tool call and PTC inner call.',
  'auto.confirm.title': 'Enable Auto review (experimental)?',
  'auto.confirm.description': 'Auto review runs without a sandbox. Before every native tool call and PTC inner call, the same model as the current agent reviews whether to allow it; you approve or reject each call it denies. This feature is experimental, can falsely allow or deny actions, and uses additional tokens.',
  'auto.confirm.acknowledge': 'I understand these risks and want to continue',
  'auto.confirm.enable': 'Enable Auto review',
  'runWild.description': 'Never asks: decides from context and your rules, acts, and logs what it did.',
  'runWild.confirm.title': 'Turn on Run Wild?',
  'runWild.confirm.description': "In Run Wild, Mumbo doesn't ask before it acts. It decides from context and your rules, then sends and posts as you, buys with saved payment methods, and deletes, and it logs each action. Still in place: it never types passwords or one-time codes, it stays off sign-in and card-entry pages, per-site limits apply, and merges, deploys and repository access still need your approval. You can switch back here at any time.",
  'runWild.confirm.acknowledge': 'I understand Mumbo will act without asking',
  'runWild.confirm.enable': 'Turn on Run Wild',
} satisfies Record<string, string>

/** Japanese copy, checked against the English keys. */
export const ja = {
  'title': '権限',
  'description': '新しいセッションのデフォルトの権限モードを選択',
  'loading': '読み込み中',
  'unavailable': '利用不可',
  'preset.readOnly': '読み取り専用',
  'preset.workspaceWrite': 'ワークスペース書き込み',
  'preset.fullAccess': 'フルアクセス',
  'confirm.title': 'フルアクセスを有効にしますか？',
  'confirm.description': 'フルアクセスでは、新しいセッションで確認ステップが減り、機密操作・ファイル変更・外部コマンドなど多くの操作を直接実行できるようになります。以降のタスクを信頼できる場合にのみ使用してください。',
  'confirm.acknowledge': 'リスクを理解し、続行します',
  'confirm.cancel': 'キャンセル',
  'confirm.enable': 'フルアクセスを有効にする',
  'runWild.confirm.title': '新しいセッションを Run Wild で開始しますか？',
  'runWild.confirm.description': '新しいセッションは Run Wild で開始され、Mumbo は実行前に確認しません。文脈とあなたのルールから判断し、あなたとして送信や投稿をし、保存済みの支払い方法で購入し、削除も行い、それぞれの操作を記録します。引き続き有効な制限: パスワードやワンタイムコードは入力せず、サインインやカード入力のページでは操作せず、サイトごとの上限が適用され、マージ、デプロイ、リポジトリへのアクセスには引き続きあなたの承認が必要です。',
  'runWild.confirm.acknowledge': 'Mumbo が確認なしで実行することを理解しました',
  'runWild.confirm.enable': 'Run Wild で開始する',
} satisfies Record<keyof typeof en, string>

/** Spanish dictionary, checked against the English keys. */
export const es = {
  'title': 'Permiso',
  'description': 'Elija el modo de permiso predeterminado para nuevas sesiones',
  'loading': 'Cargando',
  'unavailable': 'No disponible',
  'preset.readOnly': 'Sólo lectura',
  'preset.workspaceWrite': 'Escritura en el espacio de trabajo',
  'preset.fullAccess': 'Acceso completo',
  'confirm.title': '¿Habilitar acceso completo?',
  'confirm.description': 'El acceso completo permite que las nuevas sesiones reduzcan los pasos de confirmación y realicen más acciones directamente, incluidas operaciones confidenciales, cambios de archivos o comandos externos. Úselo sólo cuando confíe en las tareas posteriores.',
  'confirm.acknowledge': 'Entiendo los riesgos y quiero continuar.',
  'confirm.cancel': 'Cancelar',
  'confirm.enable': 'Habilitar acceso completo',
  'runWild.confirm.title': '¿Iniciar las nuevas sesiones en Run Wild?',
  'runWild.confirm.description': 'Las nuevas sesiones se iniciarán en Run Wild, donde Mumbo no pregunta antes de actuar. Decide según el contexto y sus reglas; luego envía y publica en su nombre, compra con los métodos de pago guardados y elimina, y registra cada acción. Sigue vigente: nunca escribe contraseñas ni códigos de un solo uso, no actúa en páginas de inicio de sesión ni de introducción de tarjetas, se aplican los límites de cada sitio, y las fusiones, los despliegues y el acceso a repositorios siguen necesitando su aprobación.',
  'runWild.confirm.acknowledge': 'Entiendo que Mumbo actuará sin preguntar',
  'runWild.confirm.enable': 'Iniciar en Run Wild',
} satisfies Record<keyof typeof en, string>

/** French dictionary, checked against the English keys. */
export const fr = {
  'title': 'Autorisation',
  'description': "Choisissez le mode d'autorisation par défaut pour les nouvelles sessions",
  'loading': 'Chargement',
  'unavailable': 'Indisponible',
  'preset.readOnly': 'Lecture seule',
  'preset.workspaceWrite': "Écriture dans l'espace de travail",
  'preset.fullAccess': 'Accès complet',
  'confirm.title': "Activer l'accès complet ?",
  'confirm.description': "L'accès complet permet aux nouvelles sessions de réduire les étapes de confirmation et d'effectuer directement davantage d'actions, notamment des opérations sensibles, des modifications de fichiers ou des commandes externes. Utilisez-le uniquement lorsque vous faites confiance aux tâches suivantes.",
  'confirm.acknowledge': 'Je comprends les risques et je veux continuer',
  'confirm.cancel': 'Annuler',
  'confirm.enable': "Activer l'accès complet",
  'runWild.confirm.title': 'Démarrer les nouvelles sessions en Run Wild ?',
  'runWild.confirm.description': "Les nouvelles sessions démarreront en Run Wild, où Mumbo ne demande rien avant d'agir. Il décide selon le contexte et vos règles, puis envoie et publie en votre nom, achète avec les moyens de paiement enregistrés et supprime, et il consigne chaque action. Restent en place : il ne saisit jamais de mots de passe ni de codes à usage unique, il n'agit pas sur les pages de connexion ni de saisie de carte, les limites par site s'appliquent, et les fusions, les déploiements et l'accès aux dépôts nécessitent toujours votre approbation.",
  'runWild.confirm.acknowledge': 'Je comprends que Mumbo agira sans demander',
  'runWild.confirm.enable': 'Démarrer en Run Wild',
} satisfies Record<keyof typeof en, string>

/** German dictionary, checked against the English keys. */
export const de = {
  'title': 'Erlaubnis',
  'description': 'Wählen Sie den Standardberechtigungsmodus für neue Sitzungen',
  'loading': 'Laden',
  'unavailable': 'Nicht verfügbar',
  'preset.readOnly': 'Nur lesen',
  'preset.workspaceWrite': 'Arbeitsbereich schreiben',
  'preset.fullAccess': 'Voller Zugriff',
  'confirm.title': 'Vollzugriff aktivieren?',
  'confirm.description': 'Durch den vollständigen Zugriff können neue Sitzungen die Bestätigungsschritte reduzieren und mehr Aktionen direkt ausführen, einschließlich vertraulicher Vorgänge, Dateiänderungen oder externer Befehle. Verwenden Sie es nur, wenn Sie nachfolgenden Aufgaben vertrauen.',
  'confirm.acknowledge': 'Ich verstehe die Risiken und möchte weitermachen',
  'confirm.cancel': 'Abbrechen',
  'confirm.enable': 'Aktivieren Sie Vollzugriff',
  'runWild.confirm.title': 'Neue Sitzungen in Run Wild starten?',
  'runWild.confirm.description': 'Neue Sitzungen starten in Run Wild, wo Mumbo nicht fragt, bevor es handelt. Es entscheidet anhand des Kontexts und Ihrer Regeln, sendet und veröffentlicht dann in Ihrem Namen, kauft mit gespeicherten Zahlungsmethoden und löscht, und es protokolliert jede Aktion. Weiterhin gilt: Es gibt nie Passwörter oder Einmalcodes ein, es handelt nicht auf Anmelde- oder Karteneingabeseiten, Limits pro Website gelten, und Merges, Deployments und Repository-Zugriffe brauchen weiterhin Ihre Zustimmung.',
  'runWild.confirm.acknowledge': 'Ich verstehe, dass Mumbo handelt, ohne zu fragen',
  'runWild.confirm.enable': 'In Run Wild starten',
} satisfies Record<keyof typeof en, string>

/** Russian dictionary, checked against the English keys. */
export const ru = {
  'title': 'Разрешение',
  'description': 'Выберите режим разрешений по умолчанию для новых сеансов',
  'loading': 'Загрузка',
  'unavailable': 'Недоступно',
  'preset.readOnly': 'Только чтение',
  'preset.workspaceWrite': 'Запись в рабочей области',
  'preset.fullAccess': 'Полный доступ',
  'confirm.title': 'Включить полный доступ?',
  'confirm.description': 'Полный доступ позволяет новым сеансам сократить количество шагов подтверждения и напрямую выполнять больше действий, включая конфиденциальные операции, изменение файлов или внешние команды. Используйте его только в том случае, если вы доверяете последующим задачам.',
  'confirm.acknowledge': 'Я понимаю риски и хочу продолжить',
  'confirm.cancel': 'Отмена',
  'confirm.enable': 'Включить полный доступ',
  'runWild.confirm.title': 'Запускать новые сеансы в Run Wild?',
  'runWild.confirm.description': 'Новые сеансы будут запускаться в режиме Run Wild, где Mumbo не спрашивает перед действием. Он решает по контексту и вашим правилам, затем отправляет и публикует от вашего имени, покупает с сохранёнными способами оплаты и удаляет, записывая каждое действие. По-прежнему действует: он никогда не вводит пароли и одноразовые коды, не действует на страницах входа и ввода карты, применяются лимиты для каждого сайта, а слияния, развёртывания и доступ к репозиториям по-прежнему требуют вашего одобрения.',
  'runWild.confirm.acknowledge': 'Я понимаю, что Mumbo будет действовать, не спрашивая',
  'runWild.confirm.enable': 'Запускать в Run Wild',
} satisfies Record<keyof typeof en, string>

/** Portuguese dictionary, checked against the English keys. */
export const pt = {
  'title': 'Permissão',
  'description': 'Escolha o modo de permissão padrão para novas sessões',
  'loading': 'Carregando',
  'unavailable': 'Indisponível',
  'preset.readOnly': 'Somente leitura',
  'preset.workspaceWrite': 'Gravação no espaço de trabalho',
  'preset.fullAccess': 'Acesso total',
  'confirm.title': 'Ativar acesso total?',
  'confirm.description': 'O acesso total permite que novas sessões reduzam as etapas de confirmação e executem mais ações diretamente, incluindo operações confidenciais, alterações de arquivos ou comandos externos. Use-o apenas quando confiar nas tarefas subsequentes.',
  'confirm.acknowledge': 'Entendo os riscos e quero continuar',
  'confirm.cancel': 'Cancelar',
  'confirm.enable': 'Ativar acesso total',
  'runWild.confirm.title': 'Iniciar novas sessões no Run Wild?',
  'runWild.confirm.description': 'As novas sessões vão começar no Run Wild, em que o Mumbo não pergunta antes de agir. Ele decide pelo contexto e pelas suas regras, depois envia e publica em seu nome, compra com as formas de pagamento salvas e exclui, e registra cada ação. Continua valendo: ele nunca digita senhas nem códigos de uso único, não age em páginas de login nem de digitação de cartão, os limites por site se aplicam, e merges, implantações e acesso a repositórios ainda precisam da sua aprovação.',
  'runWild.confirm.acknowledge': 'Entendo que o Mumbo vai agir sem perguntar',
  'runWild.confirm.enable': 'Iniciar no Run Wild',
} satisfies Record<keyof typeof en, string>

/** Japanese copy, checked against the English keys. */
export const accessJa = {
  'mode': 'アクセスモード、現在: {name}',
  'close': '閉じる',
  'preset.readOnly': '読み取り専用',
  'preset.workspaceWrite': 'ワークスペース書き込み',
  'preset.fullAccess': 'フルアクセス',
  'confirm.title': 'フルアクセスを有効にしますか？',
  'confirm.description': 'フルアクセスでは確認ステップが減り、エージェントが機密操作・ファイル変更・外部コマンドなど多くの操作を直接実行できるようになります。現在のタスクを信頼できる場合にのみ使用してください。',
  'confirm.acknowledge': 'リスクを理解し、続行します',
  'confirm.cancel': 'キャンセル',
  'confirm.enable': 'フルアクセスを有効にする',
  'auto.label': '自動認可レビュー',
  'auto.badge': 'EXP',
  'auto.description': 'すべてのネイティブツール呼び出しと PTC 内部呼び出しを実験的な同一モデルでレビューしたうえで、サンドボックスなしで実行します。',
  'auto.confirm.title': '自動認可レビュー（実験的）を有効にしますか？',
  'auto.confirm.description': '自動認可レビューはサンドボックスなしで実行されます。ネイティブツール呼び出しと PTC 内部呼び出しのたびに、現在のエージェントと同じモデルが許可可否をレビューし、拒否された呼び出しはあなたが承認または却下します。この機能は実験的であり、操作を誤って許可・拒否する可能性があり、追加のトークンを消費します。',
  'auto.confirm.acknowledge': 'これらのリスクを理解し、続行します',
  'auto.confirm.enable': '自動認可レビューを有効にする',
  'runWild.description': '確認を求めません。文脈とあなたのルールから判断して実行し、行ったことを記録します。',
  'runWild.confirm.title': 'Run Wild をオンにしますか？',
  'runWild.confirm.description': 'Run Wild では、Mumbo は実行前に確認しません。文脈とあなたのルールから判断し、あなたとして送信や投稿をし、保存済みの支払い方法で購入し、削除も行い、それぞれの操作を記録します。引き続き有効な制限: パスワードやワンタイムコードは入力せず、サインインやカード入力のページでは操作せず、サイトごとの上限が適用され、マージ、デプロイ、リポジトリへのアクセスには引き続きあなたの承認が必要です。ここでいつでも元に戻せます。',
  'runWild.confirm.acknowledge': 'Mumbo が確認なしで実行することを理解しました',
  'runWild.confirm.enable': 'Run Wild をオンにする',
} satisfies Record<keyof typeof accessEn, string>

/** Spanish dictionary, checked against the English keys. */
export const accessEs = {
  'mode': 'Modo de acceso, actual: {name}',
  'close': 'Cerrar',
  'preset.readOnly': 'Sólo lectura',
  'preset.workspaceWrite': 'Escritura en el espacio de trabajo',
  'preset.fullAccess': 'Acceso completo',
  'confirm.title': '¿Habilitar acceso completo?',
  'confirm.description': 'El acceso completo reduce los pasos de confirmación y permite al agente realizar más acciones directamente, incluidas operaciones confidenciales, cambios de archivos o comandos externos. Úselo solo cuando confíe en la tarea actual.',
  'confirm.acknowledge': 'Entiendo los riesgos y quiero continuar.',
  'confirm.cancel': 'Cancelar',
  'confirm.enable': 'Habilitar acceso completo',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Ejecute sin una zona de pruebas después de una revisión experimental del mismo modelo de cada llamada de herramienta nativa y llamada interna PTC.',
  'auto.confirm.title': '¿Habilitar Auto review (experimental)?',
  'auto.confirm.description': 'Auto review se ejecuta sin zona de pruebas. Antes de cada llamada a la herramienta nativa y llamada interna PTC, el mismo modelo que el agente actual revisa si se permite; usted aprueba o rechaza cada llamada que rechaza. Esta característica es experimental, puede permitir o denegar acciones falsamente y utiliza tokens adicionales.',
  'auto.confirm.acknowledge': 'Entiendo estos riesgos y quiero continuar',
  'auto.confirm.enable': 'Habilitar Auto review',
  'runWild.description': 'Nunca pregunta: decide según el contexto y sus reglas, actúa y registra lo que hizo.',
  'runWild.confirm.title': '¿Activar Run Wild?',
  'runWild.confirm.description': 'En Run Wild, Mumbo no pregunta antes de actuar. Decide según el contexto y sus reglas; luego envía y publica en su nombre, compra con los métodos de pago guardados y elimina, y registra cada acción. Sigue vigente: nunca escribe contraseñas ni códigos de un solo uso, no actúa en páginas de inicio de sesión ni de introducción de tarjetas, se aplican los límites de cada sitio, y las fusiones, los despliegues y el acceso a repositorios siguen necesitando su aprobación. Puede volver a cambiarlo aquí en cualquier momento.',
  'runWild.confirm.acknowledge': 'Entiendo que Mumbo actuará sin preguntar',
  'runWild.confirm.enable': 'Activar Run Wild',
} satisfies typeof accessEn

/** French dictionary, checked against the English keys. */
export const accessFr = {
  'mode': "Mode d'accès, actuel : {name}",
  'close': 'Fermer',
  'preset.readOnly': 'Lecture seule',
  'preset.workspaceWrite': "Écriture dans l'espace de travail",
  'preset.fullAccess': 'Accès complet',
  'confirm.title': "Activer l'accès complet ?",
  'confirm.description': "L'accès complet réduit les étapes de confirmation et permet à l'agent d'effectuer directement davantage d'actions, notamment des opérations sensibles, des modifications de fichiers ou des commandes externes. Utilisez-le uniquement lorsque vous faites confiance à la tâche en cours.",
  'confirm.acknowledge': 'Je comprends les risques et je veux continuer',
  'confirm.cancel': 'Annuler',
  'confirm.enable': "Activer l'accès complet",
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': "Exécutez sans bac à sable après un examen expérimental sur le même modèle de chaque appel d'outil natif et appel interne PTC.",
  'auto.confirm.title': 'Activer Auto review (expérimental) ?',
  'auto.confirm.description': "Auto review fonctionne sans bac à sable. Avant chaque appel d'outil natif et appel interne PTC, le même modèle que l'agent actuel vérifie s'il doit l'autoriser ; vous approuvez ou rejetez chaque appel qu'il refuse. Cette fonctionnalité est expérimentale, peut autoriser ou refuser à tort des actions et utilise des jetons supplémentaires.",
  'auto.confirm.acknowledge': 'Je comprends ces risques et je veux continuer',
  'auto.confirm.enable': 'Activer Auto review',
  'runWild.description': "Ne demande jamais : décide selon le contexte et vos règles, agit et consigne ce qu'il a fait.",
  'runWild.confirm.title': 'Activer Run Wild ?',
  'runWild.confirm.description': "En Run Wild, Mumbo ne demande rien avant d'agir. Il décide selon le contexte et vos règles, puis envoie et publie en votre nom, achète avec les moyens de paiement enregistrés et supprime, et il consigne chaque action. Restent en place : il ne saisit jamais de mots de passe ni de codes à usage unique, il n'agit pas sur les pages de connexion ni de saisie de carte, les limites par site s'appliquent, et les fusions, les déploiements et l'accès aux dépôts nécessitent toujours votre approbation. Vous pouvez revenir en arrière ici à tout moment.",
  'runWild.confirm.acknowledge': 'Je comprends que Mumbo agira sans demander',
  'runWild.confirm.enable': 'Activer Run Wild',
} satisfies typeof accessEn

/** German dictionary, checked against the English keys. */
export const accessDe = {
  'mode': 'Zugriffsmodus, aktuell: {name}',
  'close': 'Schließen',
  'preset.readOnly': 'Nur lesen',
  'preset.workspaceWrite': 'Arbeitsbereich schreiben',
  'preset.fullAccess': 'Voller Zugriff',
  'confirm.title': 'Vollzugriff aktivieren?',
  'confirm.description': 'Durch den Vollzugriff werden Bestätigungsschritte reduziert und der Agent kann mehr Aktionen direkt ausführen, einschließlich vertraulicher Vorgänge, Dateiänderungen oder externer Befehle. Verwenden Sie es nur, wenn Sie der aktuellen Aufgabe vertrauen.',
  'confirm.acknowledge': 'Ich verstehe die Risiken und möchte weitermachen',
  'confirm.cancel': 'Abbrechen',
  'confirm.enable': 'Aktivieren Sie Vollzugriff',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Ausführung ohne Sandbox nach einer experimentellen, modellgleichen Überprüfung jedes nativen Toolaufrufs und PTC-Innenaufrufs.',
  'auto.confirm.title': 'Auto review aktivieren (experimentell)?',
  'auto.confirm.description': 'Auto review läuft ohne Sandbox. Vor jedem nativen Tool-Aufruf und PTC-Innenaufruf überprüft dasselbe Modell wie der aktuelle Agent, ob dies zulässig ist. Sie genehmigen oder lehnen jeden abgelehnten Aufruf ab. Diese Funktion ist experimentell, kann Aktionen fälschlicherweise zulassen oder verweigern und verwendet zusätzliche Token.',
  'auto.confirm.acknowledge': 'Ich verstehe diese Risiken und möchte weitermachen',
  'auto.confirm.enable': 'Aktivieren Sie Auto review',
  'runWild.description': 'Fragt nie: entscheidet anhand des Kontexts und Ihrer Regeln, handelt und protokolliert, was es getan hat.',
  'runWild.confirm.title': 'Run Wild einschalten?',
  'runWild.confirm.description': 'In Run Wild fragt Mumbo nicht, bevor es handelt. Es entscheidet anhand des Kontexts und Ihrer Regeln, sendet und veröffentlicht dann in Ihrem Namen, kauft mit gespeicherten Zahlungsmethoden und löscht, und es protokolliert jede Aktion. Weiterhin gilt: Es gibt nie Passwörter oder Einmalcodes ein, es handelt nicht auf Anmelde- oder Karteneingabeseiten, Limits pro Website gelten, und Merges, Deployments und Repository-Zugriffe brauchen weiterhin Ihre Zustimmung. Sie können hier jederzeit zurückwechseln.',
  'runWild.confirm.acknowledge': 'Ich verstehe, dass Mumbo handelt, ohne zu fragen',
  'runWild.confirm.enable': 'Run Wild einschalten',
} satisfies typeof accessEn

/** Russian dictionary, checked against the English keys. */
export const accessRu = {
  'mode': 'Режим доступа, текущий: {name}',
  'close': 'Закрыть',
  'preset.readOnly': 'Только чтение',
  'preset.workspaceWrite': 'Запись в рабочей области',
  'preset.fullAccess': 'Полный доступ',
  'confirm.title': 'Включить полный доступ?',
  'confirm.description': 'Полный доступ сокращает количество шагов подтверждения и позволяет агенту напрямую выполнять больше действий, включая конфиденциальные операции, изменения файлов или внешние команды. Используйте его только в том случае, если вы доверяете текущей задаче.',
  'confirm.acknowledge': 'Я понимаю риски и хочу продолжить',
  'confirm.cancel': 'Отмена',
  'confirm.enable': 'Включить полный доступ',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Запуск без песочницы после экспериментальной проверки одной и той же модели каждого вызова встроенного инструмента и внутреннего вызова PTC.',
  'auto.confirm.title': 'Включить Auto review (экспериментально)?',
  'auto.confirm.description': 'Auto review работает без песочницы. Перед каждым вызовом собственного инструмента и внутренним вызовом PTC та же модель, что и текущий агент, проверяет, разрешить ли это; вы одобряете или отклоняете каждый вызов, который он отклоняет. Эта функция является экспериментальной, может ошибочно разрешать или запрещать действия и использует дополнительные токены.',
  'auto.confirm.acknowledge': 'Я понимаю эти риски и хочу продолжить',
  'auto.confirm.enable': 'Включить Auto review',
  'runWild.description': 'Никогда не спрашивает: решает по контексту и вашим правилам, действует и записывает, что сделал.',
  'runWild.confirm.title': 'Включить Run Wild?',
  'runWild.confirm.description': 'В режиме Run Wild Mumbo не спрашивает перед действием. Он решает по контексту и вашим правилам, затем отправляет и публикует от вашего имени, покупает с сохранёнными способами оплаты и удаляет, записывая каждое действие. По-прежнему действует: он никогда не вводит пароли и одноразовые коды, не действует на страницах входа и ввода карты, применяются лимиты для каждого сайта, а слияния, развёртывания и доступ к репозиториям по-прежнему требуют вашего одобрения. Вернуться можно здесь в любой момент.',
  'runWild.confirm.acknowledge': 'Я понимаю, что Mumbo будет действовать, не спрашивая',
  'runWild.confirm.enable': 'Включить Run Wild',
} satisfies typeof accessEn

/** Portuguese dictionary, checked against the English keys. */
export const accessPt = {
  'mode': 'Modo de acesso, atual: {name}',
  'close': 'Fechar',
  'preset.readOnly': 'Somente leitura',
  'preset.workspaceWrite': 'Gravação no espaço de trabalho',
  'preset.fullAccess': 'Acesso total',
  'confirm.title': 'Ativar acesso total?',
  'confirm.description': 'O acesso total reduz as etapas de confirmação e permite que o agente execute mais ações diretamente, incluindo operações confidenciais, alterações de arquivos ou comandos externos. Use-o apenas quando confiar na tarefa atual.',
  'confirm.acknowledge': 'Entendo os riscos e quero continuar',
  'confirm.cancel': 'Cancelar',
  'confirm.enable': 'Ativar acesso total',
  'auto.label': 'Auto review',
  'auto.badge': 'EXP',
  'auto.description': 'Execute sem um sandbox após uma revisão experimental do mesmo modelo de cada chamada de ferramenta nativa e PTC chamada interna.',
  'auto.confirm.title': 'Ativar Auto review (experimental)?',
  'auto.confirm.description': 'Auto review é executado sem sandbox. Antes de cada chamada de ferramenta nativa e chamada interna PTC, o mesmo modelo do agente atual analisa se deve permitir isso; você aprova ou rejeita cada chamada negada. Este recurso é experimental, pode permitir ou negar ações falsamente e usa tokens adicionais.',
  'auto.confirm.acknowledge': 'Entendo esses riscos e quero continuar',
  'auto.confirm.enable': 'Ativar Auto review',
  'runWild.description': 'Nunca pergunta: decide pelo contexto e pelas suas regras, age e registra o que fez.',
  'runWild.confirm.title': 'Ativar o Run Wild?',
  'runWild.confirm.description': 'No Run Wild, o Mumbo não pergunta antes de agir. Ele decide pelo contexto e pelas suas regras, depois envia e publica em seu nome, compra com as formas de pagamento salvas e exclui, e registra cada ação. Continua valendo: ele nunca digita senhas nem códigos de uso único, não age em páginas de login nem de digitação de cartão, os limites por site se aplicam, e merges, implantações e acesso a repositórios ainda precisam da sua aprovação. Você pode voltar aqui a qualquer momento.',
  'runWild.confirm.acknowledge': 'Entendo que o Mumbo vai agir sem perguntar',
  'runWild.confirm.enable': 'Ativar o Run Wild',
} satisfies typeof accessEn
