export type PlatformAsaasEnvironment = "sandbox" | "production";

const OFFICIAL_BASE_URLS: Record<PlatformAsaasEnvironment, string> = {
  sandbox: "https://api-sandbox.asaas.com/v3",
  production: "https://api.asaas.com/v3",
};

function parseHttpsUrl(value: string, label: string) {
  if (
    !value
    || value.length > 2048
    || [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    throw new Error(`${label} inválida`);
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} inválida`);
  }

  if (url.protocol !== "https:") {
    throw new Error(`${label} deve usar HTTPS`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${label} não pode conter credenciais, query ou fragmento`);
  }
  return url;
}

function normalizedBaseUrl(url: URL) {
  const pathname = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${pathname && pathname !== "/" ? pathname : ""}`;
}

function isLocalOrIpHostname(hostname: string) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized.endsWith(".localhost")
    || normalized.endsWith(".local")
    || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)
    || normalized.includes(":");
}

function parseAllowedProxyOrigins(value: string | undefined) {
  const origins = new Set<string>();
  for (const item of (value ?? "").split(",")) {
    const candidate = item.trim();
    if (!candidate) continue;
    const url = parseHttpsUrl(candidate, "Origem permitida do proxy Asaas");
    if (url.pathname !== "/" || isLocalOrIpHostname(url.hostname)) {
      throw new Error("Origem permitida do proxy Asaas inválida");
    }
    origins.add(url.origin);
  }
  return origins;
}

export function resolvePlatformAsaasBaseUrl(options: {
  environment: PlatformAsaasEnvironment;
  override?: string | null;
  allowSandboxOverride?: boolean;
  allowedProxyOrigins?: string;
}) {
  const officialBaseUrl = OFFICIAL_BASE_URLS[options.environment];
  const override = options.override?.trim();
  if (!override) return officialBaseUrl;

  const candidate = parseHttpsUrl(override, "PLATFORM_ASAAS_API_BASE_URL");
  const normalizedCandidate = normalizedBaseUrl(candidate);
  if (normalizedCandidate === officialBaseUrl) return officialBaseUrl;

  // A production API token must never leave the official Asaas origin/path.
  if (options.environment === "production") {
    throw new Error(
      "PLATFORM_ASAAS_API_BASE_URL de produção deve usar o endpoint oficial do Asaas",
    );
  }

  // Do not allow a sandbox token to be accidentally sent to a different Asaas
  // environment/path, even when a proxy allowlist is misconfigured.
  if (candidate.hostname.toLowerCase().endsWith(".asaas.com")) {
    throw new Error(
      "PLATFORM_ASAAS_API_BASE_URL não corresponde ao ambiente Asaas selecionado",
    );
  }
  if (!options.allowSandboxOverride) {
    throw new Error(
      "Override do endpoint Asaas requer PLATFORM_ASAAS_ALLOW_BASE_URL_OVERRIDE=true",
    );
  }
  if (isLocalOrIpHostname(candidate.hostname)) {
    throw new Error("Override do endpoint Asaas não permite host local ou IP");
  }

  const allowedOrigins = parseAllowedProxyOrigins(options.allowedProxyOrigins);
  if (!allowedOrigins.has(candidate.origin)) {
    throw new Error("Origem do proxy Asaas não está na allowlist");
  }

  return normalizedCandidate;
}
