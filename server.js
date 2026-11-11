const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const Groq = require('groq-sdk');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Connect to Supabase PostgreSQL database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function getClientData(clientId) {
  try {
    const result = await pool.query('SELECT * FROM clients WHERE client_id = $1', [clientId]);
    if (result.rows.length === 0) return null;
    
    const row = result.rows[0];
    return {
      name: row.name,
      industry: row.industry,
      botRole: row.bot_role,
      details: row.details,
      faqs: row.faqs,
      salesGoal: row.sales_goal,
      ctaLink: row.cta_link,
      status: row.status,
      currentUsage: row.current_usage
    };
  } catch (err) {
    console.error("❌ [DB ERROR] Failed to fetch client:", err.message);
    return null;
  }
}

async function incrementClientUsage(clientId) {
  try {
    await pool.query('UPDATE clients SET current_usage = current_usage + 1 WHERE client_id = $1', [clientId]);
  } catch (err) {
    console.error("❌ [DB ERROR] Failed to update usage:", err.message);
  }
}

async function saveLeadToDatabase(newLead) {
  console.log(`📥 [SAVING LEAD] Attempting to save lead for ${newLead.email}...`);

  try {
    // 1. Save to Supabase
    await pool.query(
      'INSERT INTO leads (id, client_id, name, phone, email, notes, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [newLead.id, newLead.clientId, newLead.name, newLead.phone, newLead.email, newLead.notes, newLead.timestamp]
    );
    console.log(`✅ [LEAD SAVED TO SUPABASE] Client: ${newLead.clientId}`);
  } catch (err) {
    console.error("❌ [DB ERROR] Failed to save lead to Supabase:", err.message);
  }

  // 2. Instantly push alert to Discord
  const DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1569671959963373768/g-YLoXZtZOrT2u4gmBeABZ2BxyIQwmsYIn1B0caVBHaaXbGZQlVI0NoE3WO1vfE4lANm";

  try {
    const res = await fetch(DISCORD_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content: `🚨 **NEW SALES LEAD CAPTURED!**\n**Store:** ${newLead.clientId}\n**Name:** ${newLead.name}\n**Email:** ${newLead.email}\n**Phone:** ${newLead.phone}\n**Notes:** ${newLead.notes}`
      })
    });
    console.log(`🚀 [DISCORD STATUS] Response code: ${res.status}`);
  } catch (err) {
    console.error("❌ [DISCORD ERROR] Failed to send lead:", err.message);
  }
}

const tools = [
  {
    type: "function",
    function: {
      name: "save_lead",
      description: "Saves high-intent shopper contact information for restock updates, custom size assistance, or direct sales follow-up.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Customer full name" },
          phone: { type: "string", description: "Customer phone number" },
          email: { type: "string", description: "Customer email address" },
          notes: { type: "string", description: "Customer query context or product interest" }
        },
        required: ["email"]
      }
    }
  }
];

app.post('/api/chat', async (req, res) => {
  try {
    const { message, clientId } = req.body;
    console.log(`💬 [CHAT INCOMING] Client: ${clientId} | Message: "${message}"`);

    if (!message || !clientId) {
      return res.status(400).json({ reply: "Error: Missing message or clientId." });
    }

    const clientData = await getClientData(clientId);

    if (!clientData || clientData.status !== "active") {
      return res.status(403).json({ reply: "This chat widget is inactive or the subscription has expired." });
    }

    await incrementClientUsage(clientId);

    const dynamicSystemPrompt = `You are an expert AI Sales Concierge for ${clientData.name} (${clientData.industry}).

PRIMARY RESPONSIBILITIES:
1. Act as a sharp, helpful online salesman. Answer customer questions, resolve buying hesitations, clarify sizing/logistics, and recommend products.
2. Direct shoppers to finish their purchases at: ${clientData.ctaLink}

KNOWLEDGE BASE:
- Store Details: ${clientData.details}
- Store FAQs: ${clientData.faqs}
- Sales Objective: ${clientData.salesGoal}

RULES:
- Quote all prices in US Dollars ($ USD).
- Keep responses short, direct, and conversational (2-3 sentences max). Always close with a proactive follow-up question.
- CRITICAL: If the customer provides an email address or asks to be contacted, you MUST execute the 'save_lead' tool immediately.`;

    const completion = await groq.chat.completions.create({
      model: "openai/gpt-oss-120b",
      messages: [
        { role: "system", content: dynamicSystemPrompt },
        { role: "user", content: message }
      ],
      tools: tools,
      tool_choice: "auto"
    });

    const responseMessage = completion.choices[0]?.message;

    let leadCaptured = false;
    let leadArgs = {};

    if (responseMessage.tool_calls && responseMessage.tool_calls.length > 0) {
      console.log("🛠️ [TOOL TRIGGERED] Groq called save_lead tool!");
      const toolCall = responseMessage.tool_calls[0];
      if (toolCall.function.name === 'save_lead') {
        try {
          leadArgs = JSON.parse(toolCall.function.arguments);
          leadCaptured = true;
        } catch (e) {
          console.error("Error parsing tool arguments:", e);
        }
      }
    }

    if (!leadCaptured && message.includes('@')) {
      console.log("⚡ [FALLBACK TRIGGERED] Extracted email directly from message text.");
      const extractedEmail = message.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/)?.[0];
      const extractedName = message.match(/my name is ([a-zA-Z\s]+)/i)?.[1]?.trim() || "Shopper";
      
      if (extractedEmail) {
        leadArgs = {
          name: extractedName,
          email: extractedEmail,
          phone: "Not provided",
          notes: "Captured via text fallback"
        };
        leadCaptured = true;
      }
    }

    if (leadCaptured) {
      const newLead = {
        id: "lead_" + Date.now(),
        clientId,
        name: leadArgs.name || "Not provided",
        phone: leadArgs.phone || "Not provided",
        email: leadArgs.email || "Not provided",
        notes: leadArgs.notes || "Customer query / sales inquiry",
        timestamp: new Date().toISOString()
      };
      await saveLeadToDatabase(newLead);
    }

    const reply = responseMessage?.content || `Got it! Check out our collection at ${clientData.ctaLink} and let me know if you need help picking the right size!`;
    res.json({ reply });
  } catch (error) {
    console.error("Groq API Error:", error.message);
    res.status(500).json({ reply: "Error from server: " + error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("Multi-Tenant Cloud AI Backend running on port " + PORT);
});
