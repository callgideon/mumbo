package mtls

// Checks the certificates this module issues against E2B's mtls package: run by ../check.sh, which copies this
// file into packages/shared/pkg/mtls of the E2B fork. CERTS names a directory with ca.crt and <service>.{crt,key}.

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"
)

const td = "spiffe://boxes.internal/"

func files(t *testing.T, svc string) *Files {
	dir := os.Getenv("CERTS")
	f := NewFiles(context.Background(), FileConfig{CertFile: filepath.Join(dir, svc+".crt"), KeyFile: filepath.Join(dir, svc+".key"), CAFile: filepath.Join(dir, "ca.crt")})
	f.Start(context.Background())
	return f
}

// serve runs a required listener for svc that admits allow, completing each handshake.
func serve(t *testing.T, svc string, allow ...string) string {
	list, err := ParseAllowList(allow, WithoutWildcards())
	if err != nil {
		t.Fatal(err)
	}
	inner, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	l := NewListener(inner, ServerConfig{Name: "check", Files: files(t, svc), Mode: StaticMode(ModeRequired), Allow: list})
	t.Cleanup(func() { l.Close() })
	go func() {
		for {
			c, err := l.Accept()
			if err != nil {
				return
			}
			go func() { c.Write([]byte("ok")); time.Sleep(time.Second); c.Close() }()
		}
	}()
	return inner.Addr().String()
}

// dial makes a TLS connection presenting svc's certificate (none when svc is "") and reads one byte.
func dial(t *testing.T, addr, svc string) error {
	ca, _ := os.ReadFile(filepath.Join(os.Getenv("CERTS"), "ca.crt"))
	roots := x509.NewCertPool()
	roots.AppendCertsFromPEM(ca)
	cfg := &tls.Config{RootCAs: roots, InsecureSkipVerify: true}
	if svc != "" {
		dir := os.Getenv("CERTS")
		cert, err := tls.LoadX509KeyPair(filepath.Join(dir, svc+".crt"), filepath.Join(dir, svc+".key"))
		if err != nil {
			t.Fatal(err)
		}
		cfg.Certificates = []tls.Certificate{cert}
	}
	c, err := tls.DialWithDialer(&net.Dialer{Timeout: 5 * time.Second}, "tcp", addr, cfg)
	if err != nil {
		return err
	}
	defer c.Close()
	c.SetReadDeadline(time.Now().Add(5 * time.Second))
	_, err = c.Read(make([]byte, 1))
	return err
}

func TestMumboCertificates(t *testing.T) {
	if os.Getenv("CERTS") == "" {
		t.Skip("CERTS not set")
	}
	orch := serve(t, "orchestrator", td+"api", td+"orchestrator")
	for _, c := range []struct {
		caller string
		admit  bool
	}{{"api", true}, {"orchestrator", true}, {"client-proxy", false}, {"", false}} {
		if err := dial(t, orch, c.caller); (err == nil) != c.admit {
			t.Errorf("orchestrator gRPC port, caller %q: admitted=%v want %v (%v)", c.caller, err == nil, c.admit, err)
		}
	}

	// The api's hop to an orchestrator refuses a server with any other identity.
	expect, _ := ParseAllowList([]string{td + "orchestrator"})
	hop := ClientConfig{Name: "check", Files: files(t, "api"), Mode: StaticClientMode(ClientOn), ExpectedServerIDs: expect}
	for svc, ok := range map[string]bool{"orchestrator": true, "client-proxy": false} {
		addr := serve(t, svc, td+"api")
		c, err := tls.Dial("tcp", addr, hop.clientTLSConfig(nil))
		if err == nil {
			c.Close()
		}
		if (err == nil) != ok {
			t.Errorf("api hop to %s: connected=%v want %v (%v)", svc, err == nil, ok, err)
		}
	}
}
