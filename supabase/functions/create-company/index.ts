import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Verify the caller is authenticated and is a superadmin
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Client with user's token to verify identity
    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user: caller } } = await supabaseUser.auth.getUser();
    if (!caller) {
      return new Response(JSON.stringify({ error: "Não autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Check if caller is superadmin
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

    // Parse request body
    const body = await req.json();
    const {
      name, slug, razao_social, cnpj, phone, email, address,
      responsible_name, responsible_email, responsible_phone,
    } = body;

    if (!name || !slug || !responsible_email) {
      return new Response(JSON.stringify({ error: "Nome, slug e email do responsável são obrigatórios" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 1. Create the company
    const { data: company, error: companyError } = await supabaseAdmin
      .from("companies")
      .insert({
        name, slug, razao_social, cnpj, phone, email, address,
        responsible_name, responsible_email, responsible_phone,
        status: "active",
      })
      .select()
      .single();

    if (companyError) {
      return new Response(JSON.stringify({ error: companyError.message }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Create the admin user with a temporary password
    const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";

    const { data: newUser, error: userError } = await supabaseAdmin.auth.admin.createUser({
      email: responsible_email,
      password: tempPassword,
      email_confirm: true,
      user_metadata: { full_name: responsible_name || name },
    });

    if (userError) {
      // Rollback company if user creation fails
      await supabaseAdmin.from("companies").delete().eq("id", company.id);
      return new Response(JSON.stringify({ error: `Erro ao criar usuário: ${userError.message}` }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 3. Update profile with company_id
    await supabaseAdmin
      .from("profiles")
      .update({ company_id: company.id, phone: responsible_phone })
      .eq("id", newUser.user.id);

    // 4. Assign admin role
    await supabaseAdmin
      .from("user_roles")
      .insert({
        user_id: newUser.user.id,
        role: "admin",
        company_id: company.id,
      });

    // 5. Send password reset so admin can set their own password
    await supabaseAdmin.auth.admin.generateLink({
      type: "recovery",
      email: responsible_email,
    });

    return new Response(
      JSON.stringify({
        company,
        admin_user: {
          id: newUser.user.id,
          email: responsible_email,
          temp_password: tempPassword,
        },
        message: "Empresa e usuário admin criados com sucesso!",
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
