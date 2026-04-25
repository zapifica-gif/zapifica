const apiUrl = "https://evolution-api-production-fc3d.up.railway.app"; 
const apiKey = "ZapificaAPI2026Mestre";

async function auditoria() {
  try {
    // 1. Lista todas as instâncias para sabermos o nome REAL delas
    const resInstances = await fetch(`${apiUrl}/instance/fetchInstances`, { headers: { 'apikey': apiKey } });
    const instances = await resInstances.json();
    
    console.log("📋 INSTÂNCIAS ENCONTRADAS:");
    console.log(JSON.stringify(instances, null, 2));

    if (Array.isArray(instances) && instances.length > 0) {
      for (const inst of instances) {
        const name = inst.instance.instanceName;
        // 2. Para cada instância, checa o Webhook
        const resWeb = await fetch(`${apiUrl}/webhook/find/${name}`, { headers: { 'apikey': apiKey } });
        const webData = await resWeb.json();
        console.log(`\n🔍 WEBHOOK DA INSTÂNCIA [${name}]:`);
        console.log(JSON.stringify(webData, null, 2));
      }
    } else {
      console.log("⚠️ Nenhuma instância ativa encontrada no motor.");
    }
  } catch (err) {
    console.error("❌ Erro na auditoria:", err);
  }
}
auditoria();