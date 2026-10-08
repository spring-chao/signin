const fs = require("fs"), path = require("path"), os = require("os");
const { execFileSync } = require("child_process");
const { validateStagingEnvironmentId, validateStagingHttpsUrl } = require("../../cloudfunc/staging-urls");

function prepareStaging(options, dependencies = {}) {
  const environmentId = validateStagingEnvironmentId(options.environmentId);
  const platformUrl = validateStagingHttpsUrl(options.platformUrl);
  const engineUrl = validateStagingHttpsUrl(options.engineUrl);
  const legacyUrl = validateStagingHttpsUrl(options.legacyUrl);
  const repoRoot = path.resolve(options.repoRoot || path.join(__dirname, "../.."));
  const git = dependencies.git || (args => execFileSync("git", ["-c", "safe.directory=" + repoRoot, "-C", repoRoot, ...args], { encoding: "utf8" }));
  if (git(["status", "--porcelain"]).trim()) throw new Error("STAGING_REQUIRES_CLEAN_COMMITTED_SOURCE");
  const commit = git(["rev-parse", "HEAD"]).trim();
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error("STAGING_SOURCE_COMMIT_INVALID");
  const files = git(["ls-files", "-z", "--", "cloudfunc", "public"]).split("\0").filter(Boolean);
  const output = options.outputDirectory ? path.resolve(options.outputDirectory) : path.join(os.tmpdir(), "signin-staging-" + require("crypto").randomUUID());
  if (fs.existsSync(output)) throw new Error("STAGING_OUTPUT_ALREADY_EXISTS");
  let ancestor = path.dirname(output);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  const effectiveOutput = path.resolve(fs.realpathSync(ancestor), path.relative(ancestor, output));
  const relativeOutput = path.relative(fs.realpathSync(repoRoot), effectiveOutput);
  if (!relativeOutput || (!relativeOutput.startsWith(".." + path.sep) && relativeOutput !== ".." && !path.isAbsolute(relativeOutput))) throw new Error("STAGING_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY");
  fs.mkdirSync(output, { recursive: true });
  for (const file of files) {
    if (!/^(cloudfunc|public)\//.test(file) || file.split("/").includes("..")) throw new Error("STAGING_SOURCE_PATH_INVALID");
    const source = path.resolve(repoRoot, file), destination = path.resolve(output, file);
    if (!destination.startsWith(output + path.sep) || fs.lstatSync(source).isSymbolicLink()) throw new Error("STAGING_SOURCE_PATH_INVALID");
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(source, destination);
  }
  const json = value => JSON.stringify(value, null, 2) + "\n";
  const template = JSON.parse(fs.readFileSync(path.join(repoRoot, "cloudbaserc.staging.json"), "utf8"));
  const engine = template.functions[0];
  engine.envVariables = {
    ...engine.envVariables, SIGNIN_DEPLOYMENT_MODE: "staging", SIGNIN_CLOUDBASE_ENV_ID: environmentId,
    CHECKIN_ROSTER_API_BASE: platformUrl, SIGNIN_LEGACY_URL: legacyUrl,
    SIGNIN_PLATFORM_API_KEY: "{{env.SIGNIN_PLATFORM_API_KEY}}", SIGNIN_SERVICE_API_KEY: "{{env.SIGNIN_SERVICE_API_KEY}}",
    CHECKIN_ROSTER_API_KEY: "{{env.CHECKIN_ROSTER_API_KEY}}", ADMIN_PASSWORD_HASH: "{{env.ADMIN_PASSWORD_HASH}}"
  };
  engine.dir = "cloudfunc";
  engine.installDependency = false; // Ship the exact lock-installed dependency graph.
  engine.timeout = 120;
  const retry = { ...engine, name: engine.name + "SyncRetry", triggers: engine.triggers.filter(item => item.name === "attendanceSyncRetryEvery5Minutes") };
  engine.triggers = engine.triggers.filter(item => item.name !== "attendanceSyncRetryEvery5Minutes");
  template.envId = environmentId;
  template.functions = [engine, retry]; // One timer per function; both share the isolated DB and source.
  for (const name of ["cloudbaserc.json", "cloudbaserc.staging.json"]) fs.writeFileSync(path.join(output, name), json(template));
  for (const file of ["public/index.html", "public/admin.html"]) {
    const location = path.join(output, file), original = fs.readFileSync(location, "utf8");
    const declarations = original.match(/var API\s*=\s*["'][^"']+["'];/g) || [];
    if (declarations.length !== 1) throw new Error("STAGING_STATIC_API_DECLARATION_INVALID");
    fs.writeFileSync(location, original.replace(declarations[0], "var API = " + JSON.stringify(engineUrl).replace(/</g, "\\u003c") + ";"));
  }
  const manifest = {
    version: options.version || "staging-" + commit.slice(0, 12), commit,
    deployed_at: "NOT_DEPLOYED", prepared_at: new Date().toISOString(), environment: "staging", service: "signin",
    environment_id: environmentId, platform_api_base_url: platformUrl, engine_api_base_url: engineUrl,
    legacy_url: legacyUrl, functions: template.functions.map(item => item.name),
    dependency_install: "npm ci --prefix cloudfunc --ignore-scripts --no-audit --no-fund",
    required_external_env: ["SIGNIN_PLATFORM_API_KEY", "SIGNIN_SERVICE_API_KEY", "CHECKIN_ROSTER_API_KEY", "ADMIN_PASSWORD_HASH"]
  };
  for (const file of ["cloudfunc/build-info.json", "public/build-info.json", "release-manifest.json"]) fs.writeFileSync(path.join(output, file), json(manifest));
  return { root: output, manifest };
}

if (require.main === module) {
  try {
    const args = process.argv.slice(2), values = {};
    const fields = { "--environment-id": "environmentId", "--platform-url": "platformUrl", "--engine-url": "engineUrl", "--legacy-url": "legacyUrl", "--output-directory": "outputDirectory", "--version": "version" };
    for (let index = 0; index < args.length; index += 2) {
      if (!fields[args[index]] || args[index + 1] === undefined) throw new Error("STAGING_ARGUMENT_INVALID");
      values[fields[args[index]]] = args[index + 1];
    }
    const result = prepareStaging(values);
    console.log("RELEASE_ROOT=" + result.root);
    console.log("COMMIT=" + result.manifest.commit);
    console.log("ENVIRONMENT=staging");
    console.log("STATUS=PREPARED_NOT_DEPLOYED");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepareStaging };
