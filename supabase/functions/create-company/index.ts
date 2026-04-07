import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function sanitizeOrigin(value: string | null | undefined) {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    return url.origin;
  } catch {
    return null;
  }
}

function getAppOrigin(req: Request) {
  const origin = sanitizeOrigin(req.headers.get("origin"));
  if (origin) return origin;

  const referer = req.headers.get("referer");
  if (referer) {
    try {
      return sanitizeOrigin(new URL(referer).origin);
    } catch {
      // Ignore invalid referer and fall through.
    }
  }

  return sanitizeOrigin(Deno.env.get("APP_URL"))
    ?? sanitizeOrigin(Deno.env.get("SITE_URL"));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Nao autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user: caller } } = await supabaseUser.auth.getUser();
    if (!caller) {
      return new Response(JSON.stringify({ error: "Nao autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
    const { data: callerRoles } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("user_id", caller.id)
      .eq("role", "superadmin");

    if (!callerRoles || callerRoles.length === 0) {
      return new Response(JSON.stringify({ error: "Apenas superadmins podem criar empresas" }), {
        status: 403,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      name, slug, razao_social, cnpj, phone, email, address,
      responsible_name, responsible_email, responsible_phone,
      instagram, whatsapp, google_maps_url, description, logo_url,
      opening_hours, payment_methods, reservation_duration, max_guests_per_slot,
    } = body;

    if (!name || !slug || !responsible_email) {
      return new Response(JSON.stringify({ error: "Nome, slug e email do responsavel sao obrigatorios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let company: any = null;
    let newUser: any = null;
    const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";

    const rollbackProvisioning = async () => {
      if (newUser?.user?.id) {
        const { error: deleteUserError } = await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
        if (deleteUserError) {
          console.error("Failed to rollback created user", deleteUserError);
        }
      }

      if (company?.id) {
        const { error: deleteCompanyError } = await supabaseAdmin
          .from("companies")
          .delete()
          .eq("id", company.id);

        if (deleteCompanyError) {
          console.error("Failed to rollback created company", deleteCompanyError);
        }
      }
    };

    try {
      const { data: createdCompany, error: companyError } = await supabaseAdmin
        .from("companies")
        .insert({
          name,
          slug,
          razao_social,
          cnpj,
          phone,
          email,
          address,
          responsible_name,
          responsible_email,
          responsible_phone,
          instagram,
          whatsapp,
          google_maps_url,
          description,
          logo_url,
          opening_hours,
          payment_methods,
          reservation_duration,
          max_guests_per_slot,
          status: "active",
        })
        .select()
        .single();

      if (companyError) throw new Error(companyError.message);
      company = createdCompany;

      const { data: createdUser, error: userError } = await supabaseAdmin.auth.admin.createUser({
        email: responsible_email,
        password: tempPassword,
        email_confirm: true,
        user_metadata: { full_name: responsible_name || name },
      });

      if (userError) throw new Error(`Erro ao criar usuario: ${userError.message}`);
      newUser = createdUser;

      const { error: profileError } = await supabaseAdmin
        .from("profiles")
        .update({
          company_id: company.id,
          phone: responsible_phone,
          full_name: responsible_name || name,
        })
        .eq("id", newUser.user.id);

      if (profileError) throw new Error(`Erro ao vincular perfil: ${profileError.message}`);

      const { error: roleError } = await supabaseAdmin
        .from("user_roles")
        .insert({
          user_id: newUser.user.id,
          role: "admin",
          company_id: company.id,
        });

      if (roleError) throw new Error(`Erro ao atribuir perfil admin: ${roleError.message}`);
    } catch (error: any) {
      await rollbackProvisioning();

      return new Response(JSON.stringify({ error: error.message || "Erro ao criar empresa" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const appOrigin = getAppOrigin(req);
    const redirectTo = appOrigin ? `${appOrigin}/redefinir-senha` : undefined;
    const { data: recoveryLinkData, error: recoveryError } = await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: responsible_email,
      options: redirectTo ? { redirectTo } : undefined,
    });
    const accessLink = ((recoveryLinkData as any)?.properties?.action_link
      ?? (recoveryLinkData as any)?.action_link
      ?? null) as string | null;

    const { error: auditError } = await supabaseAdmin.from("audit_logs").insert({
      user_id: caller.id,
      action: "create_company",
      entity_type: "company",
      entity_id: company.id,
      details: {
        company_name: company.name,
        company_slug: company.slug,
        admin_user_id: newUser.user.id,
        admin_email: responsible_email,
        recovery_link_generated: !recoveryError,
        recovery_link_error: recoveryError?.message || null,
      },
    });

    if (auditError) {
      console.error("Failed to write audit log for create_company", auditError);
    }

    return new Response(
      JSON.stringify({
        company,
        admin_user: {
          id: newUser.user.id,
          email: responsible_email,
          access_link: accessLink,
        },
        warning: recoveryError ? "Empresa criada, mas o link de recuperacao nao foi gerado automaticamente." : null,
        message: "Empresa e usuario admin criados com sucesso!",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
