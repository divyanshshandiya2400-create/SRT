import express from "express";
import { createServer as createViteServer } from "vite";
import multer from "multer";
import Groq from "groq-sdk";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { OAuth2Client } from "google-auth-library";
import cookieParser from "cookie-parser";
import { supabase } from "./server/supabase.ts";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;

// Request logging middleware
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.url}`);
  next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Initialize Google OAuth client
const oauth2Client = new OAuth2Client(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  `${process.env.APP_URL}/auth/callback`
);

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) {
  console.log("Creating uploads directory at:", uploadDir);
  fs.mkdirSync(uploadDir, { recursive: true });
}

// Configure Multer for file uploads with extension preservation
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    const ext = path.extname(file.originalname);
    cb(null, `${file.fieldname}-${uniqueSuffix}${ext}`);
  },
});
const upload = multer({ 
  storage: storage,
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB limit (Groq API constraint)
  }
});

// Initialize Groq
let groq: Groq | null = null;
function initGroq() {
  try {
    const apiKey = process.env.GROQ_API_KEY;
    if (apiKey) {
      console.log("Initializing Groq with API key starting with:", apiKey.substring(0, 7) + "...");
      groq = new Groq({
        apiKey: apiKey,
        timeout: 120000, // Increase timeout to 120 seconds for large files
        maxRetries: 5, // Increase retries for better resilience
      });
    } else {
      console.warn("GROQ_API_KEY is not set. Transcription will fail.");
      groq = null;
    }
  } catch (e) {
    console.error("Failed to initialize Groq:", e);
    groq = null;
  }
}

initGroq();

// Helper to format seconds to SRT timestamp
function formatSRTTime(seconds: number): string {
  const date = new Date(0);
  date.setSeconds(seconds);
  const ms = Math.floor((seconds % 1) * 1000);
  const timeString = date.toISOString().substr(11, 8);
  return `${timeString},${ms.toString().padStart(3, "0")}`;
}

// API Routes
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  console.log(`Transcription request received at ${new Date().toISOString()}`);
  let filePath: string | null = null;
  
  try {
    if (!groq) {
      // Try to re-init if key was provided later
      if (process.env.GROQ_API_KEY) {
        initGroq();
      }
      
      if (!groq) {
        return res.status(500).json({ error: "Groq API is not configured. Please set GROQ_API_KEY." });
      }
    }

    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { language = "en" } = req.body;
    filePath = req.file.path;
    const stats = fs.statSync(filePath);
    console.log(`Transcribing file: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB) in ${language}`);

    // Call Groq Whisper API
    // We use a Buffer to avoid potential stream issues with socket hang ups
    const fileBuffer = fs.readFileSync(filePath);
    
    const transcription = await groq.audio.transcriptions.create({
      file: await Groq.toFile(fileBuffer, req.file.originalname),
      model: "whisper-large-v3",
      response_format: "verbose_json",
      language: language,
    });

    console.log("Transcription successful");

    // Convert segments to SRT
    let srtContent = "";
    const transcriptionAny = transcription as any;
    if (transcriptionAny.segments) {
      transcriptionAny.segments.forEach((segment: any, index: number) => {
        srtContent += `${index + 1}\n`;
        srtContent += `${formatSRTTime(segment.start)} --> ${formatSRTTime(segment.end)}\n`;
        srtContent += `${segment.text.trim()}\n\n`;
      });
    } else {
      // Fallback if no segments (unlikely with verbose_json)
      srtContent = "1\n00:00:00,000 --> 00:00:10,000\n" + transcriptionAny.text;
    }

    res.json({ srt: srtContent });
  } catch (error: any) {
    console.error("Transcription error details:", error);
    
    // Detailed error message for the client
    let errorMessage = "Failed to transcribe";
    if (error.status === 413) errorMessage = "File too large for Groq API (max 25MB)";
    if (error.status === 401) errorMessage = "Invalid Groq API key";
    if (error.code === 'ECONNRESET' || error.message?.includes('socket hang up')) {
      errorMessage = "Connection to transcription service was lost. The file might be too large or the network is unstable. Please try again.";
    }

    res.status(error.status || 500).json({ 
      error: errorMessage,
      details: error.message,
      code: error.code
    });
  } finally {
    // Clean up uploaded file in finally block to ensure it's always deleted
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
        console.log(`Cleaned up temp file: ${filePath}`);
      } catch (e) {
        console.error("Failed to delete temp file:", e);
      }
    }
  }
});

// Health check
app.get("/api/health", async (req, res) => {
  // Re-check env var in case it was added after startup
  if (!groq && process.env.GROQ_API_KEY) {
    initGroq();
  }

  let dbStatus = "not_configured";
  let tablesMissing: string[] = [];

  if (supabase) {
    dbStatus = "connected";
    try {
      // Check if tables exist
      const { error: profileCheck } = await supabase.from('profiles').select('id').limit(0);
      if (profileCheck && profileCheck.code === '42P01') tablesMissing.push('profiles');

      const { error: subCheck } = await supabase.from('subscriptions').select('id').limit(0);
      if (subCheck && subCheck.code === '42P01') tablesMissing.push('subscriptions');
      
      if (tablesMissing.length > 0) {
        dbStatus = "tables_missing";
      }
    } catch (e) {
      dbStatus = "error";
    }
  }

  res.json({ 
    status: "ok", 
    groqConfigured: !!process.env.GROQ_API_KEY,
    groqInitialized: !!groq,
    googleConfigured: !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET,
    database: {
      status: dbStatus,
      tablesMissing: tablesMissing
    }
  });
});

// Google OAuth Routes
app.get("/api/auth/google/url", (req, res) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return res.status(500).json({ error: "Google OAuth not configured" });
  }

  const url = oauth2Client.generateAuthUrl({
    access_type: "offline",
    scope: [
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/userinfo.email",
    ],
    prompt: "consent",
  });
  res.json({ url });
});

app.get("/auth/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("No code provided");

  try {
    const { tokens } = await oauth2Client.getToken(code as string);
    oauth2Client.setCredentials(tokens);

    // Get user info
    const ticket = await oauth2Client.verifyIdToken({
      idToken: tokens.id_token!,
      audience: process.env.GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();

    if (payload && supabase) {
      // Sync user to Supabase profiles
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .upsert({
          id: payload.sub, // Google unique ID
          email: payload.email,
          full_name: payload.name,
          avatar_url: payload.picture,
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (profileError) {
        if (profileError.code === '42P01') {
          console.warn("Supabase Setup Hint: The 'profiles' table does not exist yet. This is normal if you haven't run the SQL setup script.");
        } else {
          console.error("Supabase Profile Sync Error:", profileError.message, profileError.details);
        }
      }

      // Ensure user has a subscription record (default to free)
      const { data: sub, error: subError } = await supabase
        .from('subscriptions')
        .select('*')
        .eq('user_id', payload.sub)
        .maybeSingle();

      if (subError) {
        if (subError.code === '42P01') {
          // Silent warning for expected setup state
        } else {
          console.error("Supabase Subscription Check Error:", subError.message);
        }
      }

      if (!sub) {
        const { error: insertError } = await supabase
          .from('subscriptions')
          .insert({
            user_id: payload.sub,
            status: 'active',
            plan_id: 'free',
          });
        if (insertError) {
          if (insertError.code === '42P01') {
            console.warn("Supabase Setup Hint: The 'subscriptions' table does not exist yet.");
          } else {
            console.error("Supabase Subscription Creation Error:", insertError.message);
          }
        }
      }
    }

    // Set cookie with user info (simplified for demo)
    res.cookie("user", JSON.stringify(payload), {
      httpOnly: false, // Allow client to read for demo
      secure: true,
      sameSite: "none",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    res.send(`
      <html>
        <body>
          <script>
            if (window.opener) {
              window.opener.postMessage({ type: 'OAUTH_AUTH_SUCCESS' }, '*');
              window.close();
            } else {
              window.location.href = '/';
            }
          </script>
          <p>Authentication successful. This window should close automatically.</p>
        </body>
      </html>
    `);
  } catch (error) {
    console.error("OAuth callback error:", error);
    res.status(500).send("Authentication failed");
  }
});

app.get("/api/auth/me", (req, res) => {
  const userCookie = req.cookies.user;
  if (userCookie) {
    try {
      res.json({ user: JSON.parse(userCookie) });
    } catch (e) {
      res.json({ user: null });
    }
  } else {
    res.json({ user: null });
  }
});

app.post("/api/auth/logout", (req, res) => {
  res.clearCookie("user", {
    secure: true,
    sameSite: "none",
  });
  res.json({ success: true });
});

// Supabase Subscription Routes
app.get("/api/subscription", async (req, res) => {
  const userCookie = req.cookies.user;
  if (!userCookie || !supabase) {
    return res.json({ subscription: { plan_id: 'free', status: 'active' } });
  }

  try {
    const user = JSON.parse(userCookie);
    const { data, error } = await supabase
      .from('subscriptions')
      .select('*')
      .eq('user_id', user.sub)
      .maybeSingle();

    if (error) {
      if (error.code === '42P01') {
        // This is a common error when tables aren't set up yet.
        // We handle this gracefully by returning a default free plan.
        // No need to flood the logs with errors if it's an expected setup state.
      } else {
        console.error("Supabase Fetch Subscription Error:", error.message, error.details);
      }
      return res.json({ subscription: { plan_id: 'free', status: 'active' } });
    }

    if (!data) {
      // If no subscription found, return default
      return res.json({ subscription: { plan_id: 'free', status: 'active' } });
    }

    res.json({ subscription: data });
  } catch (e) {
    res.json({ subscription: { plan_id: 'free', status: 'active' } });
  }
});

app.post("/api/subscription/update", async (req, res) => {
  const userCookie = req.cookies.user;
  const { plan_id, paypal_subscription_id, status } = req.body;

  if (!userCookie || !supabase) {
    return res.status(401).json({ error: "Unauthorized or Supabase not configured" });
  }

  try {
    const user = JSON.parse(userCookie);
    const { data, error } = await supabase
      .from('subscriptions')
      .upsert({
        user_id: user.sub,
        plan_id: plan_id || 'pro',
        status: status || 'active',
        paypal_subscription_id: paypal_subscription_id,
        updated_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw error;
    res.json({ subscription: data });
  } catch (error: any) {
    console.error("Error updating subscription:", error);
    res.status(500).json({ error: error.message });
  }
});

// Global Error Handler for API routes
app.use("/api", (err: any, req: any, res: any, next: any) => {
  console.error("API Error:", err);
  res.status(err.status || 500).json({
    error: err.message || "Internal Server Error",
  });
});

// Database initialization check
async function checkDatabase() {
  if (!supabase) {
    console.warn("⚠️ Supabase is not configured. Database features will be disabled.");
    return;
  }

  try {
    const tables = ['profiles', 'subscriptions'];
    const missing = [];

    for (const table of tables) {
      const { error } = await supabase.from(table).select('id').limit(0);
      if (error && error.code === '42P01') {
        missing.push(table);
      }
    }

    if (missing.length > 0) {
      console.error("\n" + "=".repeat(50));
      console.error("❌ DATABASE SETUP REQUIRED");
      console.error(`The following tables are missing: ${missing.join(', ')}`);
      console.error("\nACTION REQUIRED:");
      console.error("1. Open the web app in your browser.");
      console.error("2. Click the 'Get SQL Script' button in the amber banner.");
      console.error("3. Copy and run the script in your Supabase SQL Editor.");
      console.error("=".repeat(50) + "\n");
    } else {
      console.log("✅ Supabase database tables verified.");
    }
  } catch (e) {
    console.error("Failed to verify Supabase tables:", e);
  }
}

async function startServer() {
  // Check database on startup
  await checkDatabase();
  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(__dirname, "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(__dirname, "dist", "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
