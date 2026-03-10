import { createClient } from "https://esm.sh/@supabase/supabase-js@2.99.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

async function verifySuperadmin(req: Request) {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader) throw new Error("Não autorizado");

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: authHeader } },
  });

  const { data: { user: caller } } = await supabaseUser.auth.getUser();
  if (!caller) throw new Error("Não autorizado");

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);

  const { data: callerRoles } = await supabaseAdmin
    .from("user_roles")
    .select("role")
    .eq("user_id", caller.id)
    .eq("role", "superadmin");

  if (!callerRoles || callerRoles.length === 0) {
    throw new Error("Apenas superadmins podem gerenciar usuários");
  }

  return { supabaseAdmin, callerId: caller.id };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { supabaseAdmin, callerId } = await verifySuperadmin(req);
    const body = await req.json();
    const { action } = body;

    switch (action) {
      case "list_users": {
        // Get all users with admin/operator roles and their profiles
        const { data: roles, error } = await supabaseAdmin
          .from("user_roles")
          .select("user_id, role, company_id")
          .in("role", ["admin", "operator"]);

        if (error) throw new Error(error.message);

        if (!roles || roles.length === 0) {
          return new Response(JSON.stringify({ users: [] }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }

        const userIds = [...new Set(roles.map((r: any) => r.user_id))];

        // Get profiles
        const { data: profiles } = await supabaseAdmin
          .from("profiles")
          .select("id, full_name, email, phone, company_id, created_at")
          .in("id", userIds);

        // Get auth users for ban status and last sign in
        const usersData = await Promise.all(
          userIds.map(async (uid: string) => {
            const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(uid);
            return user;
          })
        );

        const users = userIds.map((uid: string) => {
          const profile = profiles?.find((p: any) => p.id === uid);
          const authUser = usersData.find((u: any) => u?.id === uid);
          const userRoles = roles.filter((r: any) => r.user_id === uid);

          return {
            id: uid,
            full_name: profile?.full_name || "",
            email: profile?.email || authUser?.email || "",
            phone: profile?.phone || "",
            company_id: profile?.company_id,
            roles: userRoles.map((r: any) => r.role),
            is_banned: authUser?.banned_until
              ? new Date(authUser.banned_until) > new Date()
              : false,
            last_sign_in: authUser?.last_sign_in_at || null,
            created_at: profile?.created_at || authUser?.created_at || "",
          };
        });

        return new Response(JSON.stringify({ users }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "toggle_ban": {
        const { user_id, ban } = body;
        if (!user_id) throw new Error("user_id é obrigatório");

        if (ban) {
          // Ban for 100 years (effectively permanent)
          const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
            ban_duration: "876000h",
          });
          if (error) throw new Error(error.message);
        } else {
          const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
            ban_duration: "none",
          });
          if (error) throw new Error(error.message);
        }

        // Audit log
        await supabaseAdmin.from("audit_logs").insert({
          user_id: callerId,
          action: ban ? "block_user" : "unblock_user",
          entity_type: "user",
          entity_id: user_id,
          details: { target_user_id: user_id },
        });

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "update_user": {
        const { user_id, full_name, email, phone, company_id, role } = body;
        if (!user_id) throw new Error("user_id é obrigatório");

        // Update profile
        const updates: any = {};
        if (full_name !== undefined) updates.full_name = full_name;
        if (email !== undefined) updates.email = email;
        if (phone !== undefined) updates.phone = phone;
        if (company_id !== undefined) updates.company_id = company_id || null;
        updates.updated_at = new Date().toISOString();

        const { error: profileError } = await supabaseAdmin
          .from("profiles")
          .update(updates)
          .eq("id", user_id);

        if (profileError) throw new Error(profileError.message);

        // If email changed, update auth user too
        if (email) {
          await supabaseAdmin.auth.admin.updateUserById(user_id, { email });
        }

        // If role changed, update user_roles
        if (role) {
          // Remove existing admin/operator roles
          await supabaseAdmin
            .from("user_roles")
            .delete()
            .eq("user_id", user_id)
            .in("role", ["admin", "operator"]);

          // Insert new role
          await supabaseAdmin.from("user_roles").insert({
            user_id,
            role,
            company_id: company_id !== undefined ? (company_id || null) : undefined,
          });

          // Also update company_id on existing roles if company changed
          if (company_id !== undefined) {
            await supabaseAdmin
              .from("user_roles")
              .update({ company_id: company_id || null })
              .eq("user_id", user_id);
          }
        } else if (company_id !== undefined) {
          // Just update company on existing roles
          await supabaseAdmin
            .from("user_roles")
            .update({ company_id: company_id || null })
            .eq("user_id", user_id);
        }

        // Audit log
        await supabaseAdmin.from("audit_logs").insert({
          user_id: callerId,
          action: "update_user",
          entity_type: "user",
          entity_id: user_id,
          details: { ...updates, role },
        });

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      case "reset_password": {
        const { user_id } = body;
        if (!user_id) throw new Error("user_id é obrigatório");

        // Get user email
        const { data: { user } } = await supabaseAdmin.auth.admin.getUserById(user_id);
        if (!user?.email) throw new Error("Usuário não encontrado");

        // Generate a new temp password
        const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";

        const { error } = await supabaseAdmin.auth.admin.updateUserById(user_id, {
          password: tempPassword,
        });
        if (error) throw new Error(error.message);

        // Audit log
        await supabaseAdmin.from("audit_logs").insert({
          user_id: callerId,
          action: "reset_password",
          entity_type: "user",
          entity_id: user_id,
          details: { email: user.email },
        });

        return new Response(
          JSON.stringify({ success: true, temp_password: tempPassword, email: user.email }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      case "seed_users": {
        const { users: seedUsers } = body;
        if (!seedUsers || !Array.isArray(seedUsers)) throw new Error("users array required");
        
        const results = [];
        for (const u of seedUsers) {
          const tempPassword = crypto.randomUUID().slice(0, 12) + "Aa1!";
          
          const { data: newUser, error: userError } = await supabaseAdmin.auth.admin.createUser({
            email: u.email,
            password: tempPassword,
            email_confirm: true,
            user_metadata: { full_name: u.full_name },
          });
          
          if (userError) {
            results.push({ email: u.email, error: userError.message });
            continue;
          }
          
          // Update profile
          await supabaseAdmin.from("profiles").update({
            company_id: u.company_id,
            phone: u.phone || null,
            full_name: u.full_name,
          }).eq("id", newUser.user.id);
          
          // Assign role
          await supabaseAdmin.from("user_roles").insert({
            user_id: newUser.user.id,
            role: u.role || "admin",
            company_id: u.company_id,
          });
          
          results.push({ email: u.email, id: newUser.user.id, temp_password: tempPassword });
        }
        
        return new Response(JSON.stringify({ results }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      default:
        return new Response(JSON.stringify({ error: "Ação inválida" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
    }
  } catch (err) {
    const status = err.message.includes("Não autorizado") ? 401
      : err.message.includes("Apenas superadmins") ? 403
      : 500;
    return new Response(JSON.stringify({ error: err.message }), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
