import assert from "node:assert/strict";
import { test } from "node:test";
import { validatePublicUrl } from "./target.js";

test("target URL policy rejects GitHub domains and subdomains before DNS", async () => {
  for (const host of [
    "github.com",
    "API.GitHub.COM.",
    "npm.pkg.github.com",
    "raw.githubusercontent.com",
    "github.githubassets.com",
    "project.github.io",
    "workspace.github.dev",
    "fulcio.githubapp.com",
    "api.githubcopilot.com",
    "ghcr.io",
  ]) {
    await assert.rejects(
      validatePublicUrl(`https://${host}/`),
      { code: "unsafe_url", message: /Use the GitHub CLI/ },
      host,
    );
  }
});

test("target URL policy rejects local, special-use, credentialed and unsafe destinations before DNS", async () => {
  const bad = [
    "file:///etc/passwd",
    "https://localhost/",
    "https://printer.local/",
    "http://0x7f000001/",
    "http://169.254.169.254/",
    "http://100.100.100.200/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fe80::1]/",
    "http://[2001:db8::1]/",
    "http://192.0.0.9/",
    "http://192.168.1.1/",
    "https://name:secret@1.1.1.1/",
    "https://1.1.1.1:8443/",
    "https://1.1.1.1/hello world",
  ];
  for (const url of bad)
    await assert.rejects(validatePublicUrl(url), { code: "unsafe_url" }, url);
  assert.equal(
    (await validatePublicUrl("https://1.1.1.1:443/path")).href,
    "https://1.1.1.1/path",
  );
  assert.equal(
    (await validatePublicUrl("https://[2606:4700:4700::1111]")).protocol,
    "https:",
  );
});
