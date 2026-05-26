import { createSupabaseAdminClient, isAuthorizedInternalJob } from "../_shared/internal-auth.ts";
import { enqueuePlugueChatMessage, getCompanyChannel, normalizePhone } from "../_shared/pluguechat.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-job-secret",
};

// Limite de destinatários por execução para não sobrecarregar a fila
const RECIPIENT_BATCH = 200;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    if (!(await isAuthorizedInternalJob(req))) {
      return new Response(JSON.stringify({ error: "Nao autorizado" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createSupabaseAdminClient();
    const now = new Date().toISOString();

    // Busca disparos agendados prontos para processar
    const { data: broadcasts } = await supabaseAdmin
      .from("pluguechat_broadcasts")
      .select("*")
      .in("status", ["draft", "scheduled"])
      .or(`scheduled_for.is.null,scheduled_for.lte.${now}`)
      .limit(10);

    if (!broadcasts || broadcasts.length === 0) {
      return new Response(JSON.stringify({ processed: 0, queued: 0 }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let totalQueued = 0;
    let processed = 0;

    for (const broadcast of broadcasts) {
      // Valida que o canal ainda é PlugueChat
      const channel = await getCompanyChannel(supabaseAdmin, broadcast.company_id);
      if (channel !== "pluguechat_official") {
        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .update({ status: "cancelled", cancel_reason: "channel_changed", cancelled_at: now })
          .eq("id", broadcast.id);
        continue;
      }

      // Marca como em processamento
      await supabaseAdmin
        .from("pluguechat_broadcasts")
        .update({ status: "processing", started_at: now })
        .eq("id", broadcast.id)
        .in("status", ["draft", "scheduled"]);

      // Busca clientes com telefone da empresa
      // audience_filter pode filtrar por segmento no futuro; por ora: todos com telefone
      const { data: customers } = await supabaseAdmin
        .from("reservations")
        .select("guest_name, guest_phone")
        .eq("company_id", broadcast.company_id)
        .not("guest_phone", "is", null)
        .limit(RECIPIENT_BATCH);

      if (!customers || customers.length === 0) {
        await supabaseAdmin
          .from("pluguechat_broadcasts")
          .update({ status: "completed", finished_at: now })
          .eq("id", broadcast.id);
        processed++;
        continue;
      }

      // Deduplicar por telefone
      const uniquePhones = new Map<string, { name: string; phone: string }>();
      for (const c of customers) {
        const phone = normalizePhone(c.guest_phone);
        if (!uniquePhones.has(phone)) {
          uniquePhones.set(phone, { name: c.guest_name ?? "", phone });
        }
      }

      let queued = 0;
      for (const { name, phone } of uniquePhones.values()) {
        // Parâmetros do disparo: o template define quais variáveis usa
        // Por padrão passamos o nome; templates de disparo devem usar apenas {{1}} = nome
        const parameters: Record<string, string> = { nome: name };

        const result = await enqueuePlugueChatMessage(supabaseAdmin, {
          company_id: broadcast.company_id,
          phone,
          type: "broadcast",
          template_id: broadcast.template_id,
          template_name: broadcast.template_name ?? null,
          parameters,
          idempotency_key: `pluguechat:broadcast:${broadcast.id}:${phone}`,
        });

        // Registra destinatário
        await supabaseAdmin.from("pluguechat_broadcast_recipients").upsert(
          {
            broadcast_id: broadcast.id,
            company_id: broadcast.company_id,
            phone,
            parameters,
            status: result === "inserted" ? "queued" : "duplicate",
          },
          { onConflict: "broadcast_id,phone" as any },
        );

        if (result === "inserted") queued++;
      }

      totalQueued += queued;

      await supabaseAdmin
        .from("pluguechat_broadcasts")
        .update({ status: "completed", finished_at: now })
        .eq("id", broadcast.id);

      processed++;
    }

    return new Response(JSON.stringify({ processed, queued: totalQueued }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error: unknown) {
    console.error("process-pluguechat-broadcasts error", error);
    const msg = error instanceof Error ? error.message : "Unknown error";
    return new Response(JSON.stringify({ error: msg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
