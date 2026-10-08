const assert = require("assert"), fs = require("fs"), os = require("os"), path = require("path");
const { spawnSync } = require("child_process");
const { prepareStaging } = require("../scripts/release/prepare-staging");
const { validateStagingEnvironmentId, validateStagingHttpsUrl, legacyCheckinUrl } = require("../cloudfunc/staging-urls");
const originalRoot = path.resolve(__dirname, ".."), temporary = fs.mkdtempSync(path.join(os.tmpdir(), "signin-staging-test-"));
const source = path.join(temporary, "source"), output = path.join(temporary, "output");
const files = ["cloudfunc/index.js", "cloudfunc/platform-service.js", "cloudfunc/staging-urls.js", "cloudfunc/package.json", "cloudfunc/package-lock.json", "public/index.html", "public/admin.html"];
const options = { environmentId: "isolated-staging-environment", platformUrl: "https://platform.signin-fixture.net/platform", engineUrl: "https://engine.signin-fixture.net/api", legacyUrl: "https://legacy.signin-fixture.net/index.html", repoRoot: source, outputDirectory: output };
const git = args => args[0] === "status" ? "" : args[0] === "rev-parse" ? "a".repeat(40) : files.join("\0") + "\0";
try {
  assert.equal(validateStagingEnvironmentId(options.environmentId), options.environmentId);
  for (const invalid of ["", "shengheshu-d2g2zyyl99f6c6fc2", "REPLACE_WITH_STAGING_ID", "bad_environment"]) assert.throws(() => validateStagingEnvironmentId(invalid), /ISOLATED_STAGING_ENVIRONMENT_REQUIRED/);
  for (const invalid of ["", "http://stage.test", "https://user:password@stage.test", "https://stage.test?secret=hidden", "https://stage.test#fragment", "https://spring-chao.github.io/signin/", "https://spring-chao.github.io./signin/", "https://REPLACE_HOST/index.html", "https://service.example", "https://localhost", "https://127.0.0.1", "https://[::1]", "https://stage.example.com", "https://stage.signin-fixture.net:8443", "https://stage.test"]) {
    assert.throws(() => validateStagingHttpsUrl(invalid), /ISOLATED_STAGING_HTTPS_URL_REQUIRED/);
    assert.equal(legacyCheckinUrl({ SIGNIN_LEGACY_URL: invalid }, "staging"), null);
  }
  assert.throws(() => validateStagingHttpsUrl("https://platform.staging.test/api", { rootOnly: true }), /ISOLATED_STAGING_HTTPS_URL_REQUIRED/);
  assert.equal(legacyCheckinUrl({}, "staging"), null);
  assert.equal(legacyCheckinUrl({}, "production"), "https://spring-chao.github.io/signin/");
  assert.equal(legacyCheckinUrl({ SIGNIN_LEGACY_URL: options.legacyUrl }, "staging"), options.legacyUrl);
  for (const file of [...files, "cloudbaserc.staging.json"]) {
    fs.mkdirSync(path.dirname(path.join(source, file)), { recursive: true });
    fs.copyFileSync(path.join(originalRoot, file), path.join(source, file));
  }
  const originalPublic = files.filter(file => file.startsWith("public/")).map(file => fs.readFileSync(path.join(source, file), "utf8"));
  assert.throws(() => prepareStaging({ ...options, environmentId: "shengheshu-d2g2zyyl99f6c6fc2" }, { git }), /ISOLATED_STAGING_ENVIRONMENT_REQUIRED/);
  assert.equal(fs.existsSync(output), false, "validation runs before creating any output");
  assert.throws(() => prepareStaging(options, { git: () => " M cloudfunc/index.js" }), /STAGING_REQUIRES_CLEAN_COMMITTED_SOURCE/);
  assert.equal(fs.existsSync(output), false, "dirty sources cannot become deployable release artifacts");
  assert.throws(() => prepareStaging({ ...options, outputDirectory: path.join(source, "unsafe-output") }, { git }), /STAGING_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY/);
  const alias = path.join(temporary, "source-alias");
  fs.symlinkSync(source, alias, "junction");
  assert.throws(() => prepareStaging({ ...options, outputDirectory: path.join(alias, "unsafe-output") }, { git }), /STAGING_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY/);
  assert.equal(fs.existsSync(path.join(source, "unsafe-output")), false);
  const prepared = prepareStaging(options, { git });
  const config = JSON.parse(fs.readFileSync(path.join(output, "cloudbaserc.json"), "utf8"));
  assert.equal(prepared.manifest.commit, "a".repeat(40));
  assert.equal(prepared.manifest.deployed_at, "NOT_DEPLOYED");
  assert.equal(prepared.manifest.environment, "staging");
  assert.equal(prepared.manifest.engine_api_base_url, options.engineUrl);
  assert.equal(prepared.manifest.platform_api_base_url, options.platformUrl);
  assert.equal(prepared.manifest.legacy_url, options.legacyUrl);
  assert.equal(config.envId, options.environmentId);
  assert.deepEqual(config.functions.map(item => item.name), ["checkinApi", "checkinApiSyncRetry"]);
  assert(config.functions.every(item => item.timeout === 120 && item.triggers.length === 1 && item.installDependency === false));
  assert.equal(config.functions[0].triggers[0].name, "attendanceSyncWeekdays0000");
  assert.equal(config.functions[1].triggers[0].name, "attendanceSyncRetryEvery5Minutes");
  for (const fn of config.functions) {
    assert.equal(fn.envVariables.SIGNIN_DEPLOYMENT_MODE, "staging");
    assert.equal(fn.envVariables.SIGNIN_CLOUDBASE_ENV_ID, options.environmentId);
    assert.equal(fn.envVariables.CHECKIN_ROSTER_API_BASE, options.platformUrl);
    assert.equal(fn.envVariables.SIGNIN_LEGACY_URL, options.legacyUrl);
    assert.equal(fn.envVariables.SIGNIN_PLATFORM_API_KEY, "{{env.SIGNIN_PLATFORM_API_KEY}}");
  }
  assert.equal(fs.readFileSync(path.join(output, "cloudbaserc.json"), "utf8"), fs.readFileSync(path.join(output, "cloudbaserc.staging.json"), "utf8"));
  for (const [index, file] of files.filter(file => file.startsWith("public/")).entries()) {
    const result = fs.readFileSync(path.join(output, file), "utf8");
    assert(result.includes('var API = "' + options.engineUrl + '";'));
    assert(!result.includes("shengheshu-d2g2zyyl99f6c6fc2-1453587887"));
    assert.equal(fs.readFileSync(path.join(source, file), "utf8"), originalPublic[index], "packaging never edits source defaults");
  }
  assert.equal(fs.existsSync(path.join(output, ".git")), false);
  assert.equal(fs.existsSync(path.join(output, ".codex-tmp")), false);
  assert.equal(fs.existsSync(path.join(output, "cloudfunc/node_modules")), false, "dependencies are installed from the copied lock as a separate explicit step");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, "cloudfunc/build-info.json"), "utf8")), prepared.manifest);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, "public/build-info.json"), "utf8")), prepared.manifest);
  assert.throws(() => prepareStaging(options, { git }), /STAGING_OUTPUT_ALREADY_EXISTS/);
  const wrapper = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(originalRoot, "scripts/release/prepare-staging.ps1"), "-EnvId", "shengheshu-d2g2zyyl99f6c6fc2", "-PlatformUrl", options.platformUrl, "-EngineUrl", options.engineUrl, "-LegacyUrl", options.legacyUrl], { encoding: "utf8" });
  assert.equal(wrapper.error, undefined, "PowerShell entry must actually execute");
  assert.notEqual(wrapper.status, 0);
  assert((wrapper.stdout + wrapper.stderr).includes("ISOLATED_STAGING_ENVIRONMENT_REQUIRED"));
  const generic = spawnSync("pwsh", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", path.join(originalRoot, "scripts/release/prepare.ps1"), "-Environment", "staging"], { encoding: "utf8" });
  assert.equal(generic.error, undefined);
  assert.notEqual(generic.status, 0);
  assert((generic.stdout + generic.stderr).includes("prepare-staging.ps1"), "the old generic entry cannot produce an unsafe staging-labeled artifact");
  console.log("staging packaging tests passed: URL/environment isolation, committed source, output-only rewrites, exact manifests, separate timers and PowerShell entry; no cloud calls");
} finally {
  const resolved = fs.realpathSync(temporary), intended = fs.realpathSync(os.tmpdir());
  if (!resolved.startsWith(intended + path.sep) || !path.basename(resolved).startsWith("signin-staging-test-")) throw new Error("unsafe fixture cleanup path");
  fs.rmSync(resolved, { recursive: true });
}
