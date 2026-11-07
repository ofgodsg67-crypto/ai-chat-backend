const express = require('express');
const cors = require('cors');
const Groq = require('groq-sdk');

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type'] }));
app.use(express.json());

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ reply: "Error: No message provided." });

    const completion = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: message }],
    });

    const reply = completion.choices[0]?.message?.content || "No response generated.";
    res.json({ reply });
  } catch (error) {
    console.error("Groq API Error Details:", error);
    res.status(500).json({ reply: Error from server: \ });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(Server running on port \));
