const PRODUCTION_ENVIRONMENT_ID = "shengheshu-d2g2zyyl99f6c6fc2";
const PRODUCTION_HOSTS = [
  "spring-chao.github.io",
  "shengheshu-d2g2zyyl99f6c6fc2-1453587887.ap-shanghai.app.tcloudbase.com",
  "seiwajyuku-platform-api-287369-8-1453587887.sh.run.tcloudbase.com"
];
const PLACEHOLDER = /replace|placeholder|your[-_ ]|todo|[<>{}]/i;
const { isIP } = require("net");

function validateStagingEnvironmentId(value) {
  const id = String(value || "").trim();
  if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(id) || id === PRODUCTION_ENVIRONMENT_ID || PLACEHOLDER.test(id) || /example/i.test(id)) throw new Error("ISOLATED_STAGING_ENVIRONMENT_REQUIRED");
  return id;
}

function validateStagingHttpsUrl(value, { rootOnly = false } = {}) {
  const raw = String(value || "").trim();
  let url;
  try { url = new URL(raw); } catch (error) { throw new Error("ISOLATED_STAGING_HTTPS_URL_REQUIRED"); }
  const hostname = url.hostname.replace(/\.$/, "").toLowerCase();
  const production = PRODUCTION_HOSTS.some(host => hostname === host || hostname.endsWith("." + host));
  const placeholder = !hostname.includes(".") || isIP(hostname.replace(/^\[|\]$/g, "")) ||
    /(?:^|\.)(?:localhost|local|lan|invalid|test|example)$/.test(hostname) ||
    /(?:^|\.)example\.(?:com|net|org)$/.test(hostname);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || (url.port && url.port !== "443") || /[?#]/.test(raw) || PLACEHOLDER.test(raw) || placeholder || raw.includes(PRODUCTION_ENVIRONMENT_ID) || production || (rootOnly && url.pathname !== "/")) throw new Error("ISOLATED_STAGING_HTTPS_URL_REQUIRED");
  url.hostname = hostname;
  return url.href.replace(/\/$/, "");
}

function legacyCheckinUrl(env, mode) {
  if (["staging", "staging-shared"].includes(String(mode || "").toLowerCase())) {
    try { return validateStagingHttpsUrl(env.SIGNIN_LEGACY_URL); } catch (error) { return null; }
  }
  try {
    const configured = new URL(String(env.SIGNIN_LEGACY_URL || ""));
    if (configured.protocol === "https:" && !configured.username && !configured.password) return configured.href;
  } catch (error) { /* Preserve the existing production default. */ }
  return "https://spring-chao.github.io/signin/";
}

module.exports = { PRODUCTION_ENVIRONMENT_ID, validateStagingEnvironmentId, validateStagingHttpsUrl, legacyCheckinUrl };
