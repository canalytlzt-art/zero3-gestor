const workerSettingsLocation =
  "Cloudflare > Workers & Pages > Worker do ambiente > Settings > Variables and Secrets";

function missingWorkerSetting(name: string, detail: string): string {
  return `${detail} (${name}). Configure em ${workerSettingsLocation}.`;
}

export function accessValidationError(error: unknown) {
  const candidate = error as {
    status?: unknown;
    data?: { code?: unknown; error?: unknown } | null;
  } | null;
  const status = typeof candidate?.status === "number" ? candidate.status : null;
  const code = typeof candidate?.data?.code === "string" ? candidate.data.code : null;

  const descriptions: Record<string, string> = {
    session_missing: "O Worker não recebeu a sessão. Saia da conta e entre novamente.",
    session_expired: "Sua sessão expirou. Entre novamente.",
    session_invalid: "A sessão não pôde ser validada. Entre novamente.",
    clerk_verification_unavailable: "Não foi possível validar a sessão no momento. Tente novamente mais tarde.",
    clerk_secret_missing: missingWorkerSetting("CLERK_SECRET_KEY", "Falta a chave secreta do Clerk no Worker"),
    clerk_secret_rejected: "O Clerk rejeitou CLERK_SECRET_KEY. Confirme, nas Secrets do Worker, se ela pertence à mesma instância Clerk Development.",
    clerk_jwt_key_missing: missingWorkerSetting("CLERK_JWT_KEY", "Falta a chave pública PEM do Clerk no Worker"),
    clerk_issuer_missing_or_invalid: missingWorkerSetting("CLERK_ISSUER", "O emissor HTTPS do Clerk está ausente ou inválido"),
    clerk_authorized_parties_missing: missingWorkerSetting("CLERK_AUTHORIZED_PARTIES", "As origens permitidas do Clerk não estão configuradas"),
    request_origin_not_authorized: "A origem deste endereço não está permitida. Confira CLERK_AUTHORIZED_PARTIES nas Variables and Secrets do Worker.",
    request_origin_required: "O Worker bloqueou uma operação com sessão por cookie sem a origem explícita da página.",
    clerk_instance_mismatch: "O usuário da sessão não existe na instância Clerk consultada. Confirme que a chave pública do build e CLERK_SECRET_KEY, CLERK_JWT_KEY e CLERK_ISSUER pertencem à mesma instância Development.",
    clerk_unavailable: "O Worker não conseguiu consultar o Clerk. Tente novamente em instantes.",
    clerk_user_lookup_failed: "O Clerk não conseguiu confirmar o usuário autenticado.",
    clerk_user_response_invalid: "O Clerk retornou uma resposta inválida ao consultar o usuário.",
    verified_email_required: "A conta Clerk precisa ter um e-mail principal verificado.",
    admin_allowlist_missing: missingWorkerSetting("ZERO3_ALLOWED_EMAILS", "A lista de administradores não está configurada no Worker"),
  };

  let message = code ? descriptions[code] : undefined;
  if (!message && status === 401) message = "O Worker não validou a sessão Clerk. Entre novamente.";
  if (!message && status === 403) message = "A sessão foi validada, mas a conta não tem permissão administrativa.";
  if (!message && status !== null && status >= 500) message = "O Worker ou o Clerk falhou ao validar o acesso. Consulte os logs do Worker.";
  if (!message && status !== null) message = `A API de acesso respondeu com HTTP ${status}.`;
  if (!message) message = "A requisição não recebeu uma resposta HTTP. Verifique a conexão e a disponibilidade do Worker.";

  return {
    message,
    detail: `GET /api/access-status · ${status === null ? "sem resposta HTTP" : `HTTP ${status}`}${code ? ` · ${code}` : ""}`,
  };
}
