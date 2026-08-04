import {
  assertSuperadmin,
  getClientIpAddress,
} from "../_shared/internal-auth.ts";
import {
  decryptPlatformAsaasToken,
  encryptPlatformAsaasToken,
  normalizePlatformBillingEnvironment,
  platformBillingCorsHeaders,
  platformBillingJsonResponse,
  publicPlatformBillingConfig,
  readPlatformBillingJson,
  safePlatformBillingError,
  validatePlatformAsaasToken,
} from "../_shared/platform-billing.ts";

const CONFIG_COLUMNS = [
  "api_token_encrypted",
  "api_environment",
  "source_revision",
  "module_enabled",
  "token_last_four",
  "token_validated_at",
  "token_last_error",
  "updated_at",
].join(", ");

async function loadConfig(supabaseAdmin: any) {
  const { data, error } = await supabaseAdmin
    .from("platform_billing_config")
    .select(CONFIG_COLUMNS)
    .eq("id", true)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return data as Record<string, unknown> | null;
}

async function auditConfigAction(
  supabaseAdmin: any,
  req: Request,
  userId: string,
  action: string,
  details: Record<string, unknown>,
) {
  const { error } = await supabaseAdmin.from("audit_logs").insert({
    user_id: userId,
    action,
    entity_type: "platform_billing_config",
    entity_id: null,
    details,
    ip_address: getClientIpAddress(req),
  });

  if (error) console.warn("Failed to audit platform billing config action", error);
}

function statusForError(message: string) {
  if (message === "Nao autorizado") return 401;
  if (message === "Sem permissao") return 403;
  if (message.includes("source revision changed") || message.includes("recarregue")) return 409;
  if (
    message.includes("obrigatorio")
    || message.includes("invalido")
    || message.includes("nao configurado")
    || message.includes("antes de ativar")
  ) return 400;
  return 500;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: platformBillingCorsHeaders });
  }

  if (req.method !== "POST") {
    return platformBillingJsonResponse({ ok: false, error: "Method not allowed" }, 405);
  }

  try {
    const body = await readPlatformBillingJson(req);
    const action = typeof body.action === "string" ? body.action : "get";
    const { supabaseAdmin, user } = await assertSuperadmin(req);
    const existing = await loadConfig(supabaseAdmin);

    if (action === "get") {
      return platformBillingJsonResponse({
        ok: true,
        config: publicPlatformBillingConfig(existing),
      });
    }

    if (action === "test") {
      const providedToken = typeof body.api_token === "string" ? body.api_token.trim() : "";
      const savedEnvironment = existing?.api_environment === "sandbox"
        ? "sandbox"
        : "production";
      const environment = normalizePlatformBillingEnvironment(
        body.environment,
        savedEnvironment,
      );

      if (!providedToken && environment !== savedEnvironment) {
        const message =
          "O token salvo so pode ser testado no ambiente em que foi configurado";
        await auditConfigAction(
          supabaseAdmin,
          req,
          user.id,
          "test_platform_billing_token",
          {
            environment,
            saved_environment: savedEnvironment,
            success: false,
            used_saved_token: true,
            error: message,
          },
        );
        return platformBillingJsonResponse({
          ok: false,
          valid: false,
          error: message,
        }, 400);
      }

      let tokenToTest = providedToken;
      if (!tokenToTest) {
        if (typeof existing?.api_token_encrypted !== "string") {
          await auditConfigAction(
            supabaseAdmin,
            req,
            user.id,
            "test_platform_billing_token",
            {
              environment,
              success: false,
              used_saved_token: true,
              error: "Token global Asaas nao configurado",
            },
          );
          return platformBillingJsonResponse({
            ok: false,
            valid: false,
            error: "Token global Asaas nao configurado",
          }, 400);
        }
      }

      try {
        if (!tokenToTest) {
          tokenToTest = await decryptPlatformAsaasToken(existing!.api_token_encrypted as string);
        }
        await validatePlatformAsaasToken(tokenToTest, environment);

        if (!providedToken) {
          const now = new Date().toISOString();
          const { data: updated, error } = await supabaseAdmin
            .from("platform_billing_config")
            .update({
              token_validated_at: now,
              token_last_error: null,
              updated_at: now,
              updated_by: user.id,
            })
            .eq("id", true)
            .eq("source_revision", existing?.source_revision)
            .select("source_revision")
            .maybeSingle();
          if (error) throw new Error(error.message);
          if (!updated) {
            throw new Error("A configuracao Asaas mudou; recarregue antes de testar novamente");
          }
        }

        await auditConfigAction(
          supabaseAdmin,
          req,
          user.id,
          "test_platform_billing_token",
          { environment, success: true, used_saved_token: !providedToken },
        );

        return platformBillingJsonResponse({ ok: true, valid: true, environment });
      } catch (error) {
        const message = safePlatformBillingError(error);
        if (message.includes("recarregue")) {
          await auditConfigAction(
            supabaseAdmin,
            req,
            user.id,
            "test_platform_billing_token",
            {
              environment,
              success: false,
              used_saved_token: !providedToken,
              source_revision_stale: true,
              error: message,
            },
          );
          return platformBillingJsonResponse({ ok: false, valid: false, error: message }, 409);
        }

        if (!providedToken) {
          const now = new Date().toISOString();
          const { data: disabled, error: disableError } = await supabaseAdmin
            .from("platform_billing_config")
            .update({
              token_last_error: message,
              module_enabled: false,
              updated_at: now,
              updated_by: user.id,
            })
            .eq("id", true)
            .eq("source_revision", existing?.source_revision)
            .select("source_revision")
            .maybeSingle();
          if (disableError) throw new Error(disableError.message);
          if (!disabled) {
            const staleMessage = "A configuracao Asaas mudou; recarregue antes de testar novamente";
            await auditConfigAction(
              supabaseAdmin,
              req,
              user.id,
              "test_platform_billing_token",
              {
                environment,
                success: false,
                used_saved_token: true,
                source_revision_stale: true,
                error: staleMessage,
              },
            );
            return platformBillingJsonResponse({
              ok: false,
              valid: false,
              error: staleMessage,
            }, 409);
          }
        }

        await auditConfigAction(
          supabaseAdmin,
          req,
          user.id,
          "test_platform_billing_token",
          {
            environment,
            success: false,
            used_saved_token: !providedToken,
            module_disabled: !providedToken,
            error: message,
          },
        );

        return platformBillingJsonResponse({ ok: false, valid: false, error: message }, 400);
      }
    }

    if (action === "save") {
      const apiToken = typeof body.api_token === "string" ? body.api_token.trim() : "";
      if (!apiToken) {
        return platformBillingJsonResponse({ ok: false, error: "Token Asaas obrigatorio" }, 400);
      }
      if (apiToken.length > 2048) {
        return platformBillingJsonResponse({ ok: false, error: "Token Asaas invalido" }, 400);
      }

      const currentEnvironment = existing?.api_environment === "sandbox" ? "sandbox" : "production";
      const environment = normalizePlatformBillingEnvironment(body.environment, currentEnvironment);

      try {
        await validatePlatformAsaasToken(apiToken, environment);
      } catch (error) {
        const message = safePlatformBillingError(error);
        await auditConfigAction(
          supabaseAdmin,
          req,
          user.id,
          "save_platform_billing_token",
          { environment, success: false, error: message },
        );
        return platformBillingJsonResponse({ ok: false, error: message }, 400);
      }

      const now = new Date().toISOString();
      if (typeof existing?.source_revision !== "string") {
        throw new Error("Revisao da fonte Asaas nao configurada");
      }
      let encryptedToken: string;
      try {
        encryptedToken = await encryptPlatformAsaasToken(apiToken);
      } catch (error) {
        const message = safePlatformBillingError(error);
        await auditConfigAction(
          supabaseAdmin,
          req,
          user.id,
          "save_platform_billing_token",
          { environment, success: false, stage: "encrypt", error: message },
        );
        throw error;
      }

      const { data: rotationData, error: rotationError } = await supabaseAdmin.rpc(
        "rotate_platform_billing_source",
        {
          _expected_source_revision: existing.source_revision,
          _api_token_encrypted: encryptedToken,
          _api_environment: environment,
          _token_last_four: apiToken.slice(-4),
          _token_validated_at: now,
          _updated_by: user.id,
        },
      );
      if (rotationError) {
        const message = safePlatformBillingError(rotationError);
        await auditConfigAction(
          supabaseAdmin,
          req,
          user.id,
          "save_platform_billing_token",
          {
            environment,
            success: false,
            stage: "rotate_source",
            source_revision_stale: message.includes("source revision changed"),
            error: message,
          },
        );
        throw new Error(message);
      }

      const rotation = (rotationData && typeof rotationData === "object")
        ? rotationData as Record<string, unknown>
        : {};

      await auditConfigAction(
        supabaseAdmin,
        req,
        user.id,
        "save_platform_billing_token",
        {
          environment,
          success: true,
          token_replaced: rotation.token_replaced === true,
          environment_changed: rotation.environment_changed === true,
          source_changed: true,
          module_disabled_for_source_change: true,
          purged_cached_invoice_count: Number(rotation.purged_invoice_count ?? 0),
          invalidated_link_count: Number(rotation.invalidated_link_count ?? 0),
        },
      );

      return platformBillingJsonResponse({
        ok: true,
        config: publicPlatformBillingConfig(await loadConfig(supabaseAdmin)),
      });
    }

    if (action === "set_enabled") {
      if (typeof body.enabled !== "boolean") {
        return platformBillingJsonResponse({ ok: false, error: "enabled deve ser boolean" }, 400);
      }

      const configured = Boolean(
        existing?.api_token_encrypted
        && existing?.token_validated_at
        && !existing?.token_last_error
      );
      if (body.enabled && !configured) {
        return platformBillingJsonResponse({
          ok: false,
          error: "Valide e salve o token global Asaas antes de ativar o modulo",
        }, 400);
      }

      const now = new Date().toISOString();
      if (typeof existing?.source_revision !== "string") {
        throw new Error("Revisao da fonte Asaas nao configurada");
      }
      let enableQuery = supabaseAdmin
        .from("platform_billing_config")
        .update({
          module_enabled: body.enabled,
          updated_at: now,
          updated_by: user.id,
        })
        .eq("id", true)
        .eq("source_revision", existing.source_revision);
      if (body.enabled) {
        enableQuery = enableQuery
          .not("api_token_encrypted", "is", null)
          .not("token_validated_at", "is", null)
          .is("token_last_error", null);
      }
      const { data: updated, error } = await enableQuery
        .select("source_revision")
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (!updated) {
        const message = "A configuracao Asaas mudou; recarregue antes de alterar o modulo";
        await auditConfigAction(
          supabaseAdmin,
          req,
          user.id,
          "set_platform_billing_enabled",
          {
            enabled: body.enabled,
            success: false,
            source_revision_stale_or_token_invalid: true,
          },
        );
        return platformBillingJsonResponse({ ok: false, error: message }, 409);
      }

      await auditConfigAction(
        supabaseAdmin,
        req,
        user.id,
        "set_platform_billing_enabled",
        { enabled: body.enabled, success: true },
      );

      return platformBillingJsonResponse({
        ok: true,
        config: publicPlatformBillingConfig(await loadConfig(supabaseAdmin)),
      });
    }

    return platformBillingJsonResponse({ ok: false, error: "Acao invalida" }, 400);
  } catch (error) {
    const message = safePlatformBillingError(error);
    return platformBillingJsonResponse({ ok: false, error: message }, statusForError(message));
  }
});
