import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from "https://esm.sh/@supabase/supabase-js@2"

serve(async (req) => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? ''
  const supabaseServiceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  // Usamos a chave Service Role para ter poder de Admin e pular as RLS
  const supabase = createClient(supabaseUrl, supabaseServiceRoleKey)

  try {
    const now = new Date().toISOString()

    // 1. Pega até 30 mensagens pendentes que já passaram do horário de envio
    const { data: messages, error: fetchError } = await supabase
      .from('scheduled_messages')
      .select('*')
      .eq('status', 'pending')
      .lte('scheduled_at', now)
      .limit(30)

    if (fetchError) throw fetchError
    if (!messages || messages.length === 0) {
      return new Response(JSON.stringify({ message: "Nenhuma mensagem pendente." }), { headers: { "Content-Type": "application/json" } })
    }

    // 2. Processa cada mensagem
    for (const msg of messages) {
      // Muda o status para processando
      await supabase.from('scheduled_messages').update({ status: 'processing' }).eq('id', msg.id)

      try {
        const evolutionUrl = Deno.env.get('EVOLUTION_API_URL') ?? ''
        const evolutionApiKey = Deno.env.get('EVOLUTION_API_KEY') ?? ''
        const instanceName = msg.evolution_instance_name ?? 'Zapifica' 
        
        // --- LÓGICA CORRIGIDA PARA ENCONTRAR OS TELEFONES ---
        let phonesToSend: string[] = []
        
        if (msg.recipient_type === 'personal' && msg.recipient_phone) {
            phonesToSend.push(msg.recipient_phone)
        } else if (msg.recipient_type === 'segment' && msg.segment_lead_ids && msg.segment_lead_ids.length > 0) {
            // Busca o telefone diretamente do contato que você selecionou!
            const { data: leadsData } = await supabase
                .from('leads')
                .select('telefone')
                .in('id', msg.segment_lead_ids)
            
            if (leadsData) {
                phonesToSend = leadsData.map((l: any) => l.telefone).filter((t: any) => t)
            }
        }

        if (phonesToSend.length === 0) {
            throw new Error('Nenhum telefone válido encontrado para envio.')
        }

        let lastEvolutionId = null

        // Dispara a mensagem para cada telefone encontrado
        for (const phone of phonesToSend) {
            const cleanPhone = phone.replace(/\D/g, '') // Garante que só vão os números
            
            const response = await fetch(`${evolutionUrl}/message/sendText/${instanceName}`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'apikey': evolutionApiKey
              },
              body: JSON.stringify({
                number: cleanPhone, 
                text: msg.message_body // <-- AQUI ESTAVA O ERRO! AGORA ESTÁ LENDO A COLUNA CERTA.
              })
            })

            if (!response.ok) {
               throw new Error(`Erro na Evolution API: ${response.statusText}`)
            }
            
            const responseData = await response.json()
            lastEvolutionId = responseData?.message?.key?.id ?? responseData?.key?.id ?? null
        }

        // Deu certo! Atualiza para enviado
        await supabase.from('scheduled_messages').update({ 
            status: 'sent',
            evolution_message_id: lastEvolutionId,
            last_error: null
        }).eq('id', msg.id)

      } catch (err: any) {
        // Deu erro no disparo, salva o erro para visualizarmos na agenda
        await supabase.from('scheduled_messages').update({ 
            status: 'error',
            last_error: err.message
        }).eq('id', msg.id)
      }
    }

    return new Response(JSON.stringify({ message: `Processado ${messages.length} mensagens.` }), { headers: { "Content-Type": "application/json" } })
  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } })
  }
})