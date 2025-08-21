# Playwright MCP — Jenkins Pipeline (Phase 3, Patched)

This README explains the **AI-driven E2E testing pipeline** that uses **Microsoft Playwright MCP** + **OpenAI** to test the `todomvc-react` app in **Jenkins** before deployment.

---

## 1) What This Project Does (Quick)

- Spins up **TodoMVC** (React) and **Playwright MCP** as Docker containers with **`--network=host`**.
- Runs a Node **AI runner** (`scripts/ai-runner.js`) that:
  - Connects to MCP via **StreamableHTTPClientTransport**.
  - Optionally captures a **DOM snapshot**.
  - Prompts the LLM to return **only a JSON array** of MCP tool calls (e.g., `browser_navigate`, `browser_type`, `browser_press_key`, `browser_wait_for`, `browser_take_screenshot`).
  - Executes the tool calls against the app.
  - Saves artifacts to `${WORKSPACE}/artifacts` and writes a **JUnit** report to `${WORKSPACE}/reports/junit.xml`.
  - Exits **non‑zero on failure** so Jenkins fails the build.

**No HTTP endpoints.** The runner uses MCP **tools**, not `/execute` or `/dom` URLs.

---

## 2) Prerequisites

- **Docker** installed and running.
- **Node.js 18+** available on the Jenkins agent.
- **Jenkins** installed and accessible.
- Jenkins user belongs to the **docker** group (so Jenkins can run `docker`).
- **OPENAI_API_KEY** stored as a **Jenkins credential (Secret text/String)**.

> Optional local repro: see **Appendix B**.

---

## 3) Jenkins Setup (RHEL based instructions cause I'm running Fedora)

1) **Install Java & Jenkins**
   ```bash
   sudo dnf install -y java-17-openjdk wget
   sudo wget -O /etc/yum.repos.d/jenkins.repo https://pkg.jenkins.io/redhat-stable/jenkins.repo
   sudo rpm --import https://pkg.jenkins.io/redhat-stable/jenkins.io.key
   sudo dnf install -y jenkins
   sudo systemctl enable --now jenkins
   ```
   Access the UI at `http://<server-ip>:8080` and get the initial admin password:
   ```bash
   sudo cat /var/lib/jenkins/secrets/initialAdminPassword
   ```

2) **Install & enable Docker**
   ```bash
   sudo dnf install -y docker
   sudo systemctl enable --now docker
   ```

3) **Let Jenkins run Docker**
   ```bash
   sudo usermod -aG docker jenkins
   sudo systemctl restart jenkins
   ```

4) **Create credentials**
   - In **Jenkins → Manage Jenkins → Credentials**, add **Secret text**:
     - ID: `OPENAI_API_KEY` (or your preferred ID)
     - Secret: your API key

---

## 4) Repository Layout (minimum)

```
.
├─ Jenkinsfile
├─ scripts/
│  └─ ai-runner.js
```

**Notes**
- The runner reads env vars inside the stage (`MCP_URL`, `APP_URL`, `ARTIFACTS_DIR`, `OPENAI_MODEL`).
- If the **OpenAI API** is temporarily unavailable, the runner will fail; Jenkins will show logs from the stage.
- Artifacts land in `${WORKSPACE}/artifacts`; JUnit report is `${WORKSPACE}/reports/junit.xml`.

---

## 5) Known Issues / Troubleshooting

### A) `browser_take_screenshot` not saving an image

**Symptoms**
- The MCP tool call "succeeds" but no image file appears in `artifacts/`.
- Tool response content is present but doesn't contain an `image` part or valid base64 payload.

**What the runner already does**
- Requests screenshots with `{"raw": true}` (so MCP returns an image payload).
- Looks for either:
  - `content[?].type === "image"` with a `data` field (base64), **or**
  - `content[?].type === "text"` containing a `data:` URL or base64 block.
- Auto-detects output extension (png/jpg/webp/gif).

**Things to check**
1. **MCP version**: Ensure the `mcr.microsoft.com/playwright/mcp` image is current (`docker pull` before each run).
2. **Artifacts mount**: Confirm `-v "${WORKSPACE}/artifacts:/artifacts"` is present and Jenkins has write perms.
3. **Raw flag**: The tool call must set `raw: true` so images don't get reduced to text metadata.
4. **Payload shape**: Inspect stage logs. If `result.content` lacks an image or usable base64, dump the full tool response once to verify shape.
5. **Headless/Display**: Keep `--shm-size=1g` and `--headless`. If still flaky, try with a larger `--shm-size` or remove headless temporarily to test.
6. **Timing**: Add a small wait before the screenshot step or ensure the target element is visible (`browser_wait_for`) right before capture.
7. **Permissions**: Jenkins workspace + `artifacts` dir should be 0777 or owned by `jenkins:docker` depending on your setup.

**Workaround while investigating**
- Rely on **DOM snapshots** (`browser_snapshot`) which are saved as `dom-snapshot-*.html` in `artifacts/`.
- Use JUnit failure/console logs for verification until screenshots stabilize.

### B) `ERR_CONNECTION_REFUSED` in DOM snapshot

- This usually means the app isn't ready yet.
- The runner already retries navigation and `.new-todo` waits; if it still fails, check that the app container is healthy and port 3000 is free on the host.

### C) OpenAI outages / rate limits

- The runner exits non‑zero; Jenkins will mark the stage failed.
- Re‑run once service recovers; consider a fallback model ID or a short retry loop around the completion call if desired.

---

## Appendix A — Adding `scripts/ai-runner.js` in Jenkinsfile

In your Jenkinsfile, the runner script is created in the `Write ai-runner.js` stage.  
Paste the full content of your `ai-runner.js` (from this repo) right after the `EOF` marker:

```groovy
stage('Write ai-runner.js') {
    steps {
        sh '''
            mkdir -p scripts
            cat > scripts/ai-runner.js <<'EOF'
#!/usr/bin/env node
// paste the full ai-runner.js script content here
EOF
            chmod +x scripts/ai-runner.js
        '''
    }
}
```

- **Keep the shebang line** (`#!/usr/bin/env node`) at the very top.  
- Don't add anything after the closing `EOF`.  
- When the pipeline runs, Jenkins will write the script into `scripts/ai-runner.js` and make it executable.

---

## Appendix B — Minimal Local Repro (Optional)

```bash
# 1) Start the app
docker run -d --rm --name todomvc --network=host dhruvd22/todomvc-react

# 2) Start MCP
mkdir -p artifacts
docker run -d --rm --name mcp --network=host --shm-size=1g \
  -v "$PWD/artifacts:/artifacts" \
  mcr.microsoft.com/playwright/mcp \
  --port 7000 --host 0.0.0.0 --output-dir /artifacts --headless

# 3) Run the AI runner (ensure OPENAI_API_KEY is set in your shell)
node scripts/ai-runner.js
```