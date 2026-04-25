const webhookUrl = "https://hkcisuewgzhyzozwurzf.supabase.co/functions/v1/evolution-whatsapp-webhook";
const instanceName = "zapifica_e36ab095-664f-4b31-9bb3-7f01df1ef970";

// Dados reais puxados do seu .env
const apiUrl = "https://evolution-api-production-fc3d.up.railway.app"; 
const apiKey = "ZapificaAPI2026Mestre";

fetch(`${apiUrl}/webhook/set/${instanceName}`, {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'apikey': apiKey
  },
  body: JSON.stringify({
    webhook: {
      enabled: true,
      url: webhookUrl,
      base64: true, // A MÁGICA ACONTECE AQUI!
      byEvents: false,
      events: ["MESSAGES_UPSERT"]
    }
  })
})
.then(res => res.json())
.then(data => console.log("✅ Webhook atualizado com sucesso! Pode testar a foto.", JSON.stringify(data, null, 2)))
.catch(err => console.error("❌ Erro:", err));