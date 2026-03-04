import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase credentials missing. Database features will be disabled.');
}

export const supabase = (supabaseUrl && supabaseServiceKey) 
  ? createClient(supabaseUrl, supabaseServiceKey)
  : null;

/**
 * Database Schema Recommendation (Run this in Supabase SQL Editor):
 * 
 * CREATE TABLE IF NOT EXISTS profiles (
 *   id TEXT PRIMARY KEY, -- Google sub ID
 *   email TEXT UNIQUE,
 *   full_name TEXT,
 *   avatar_url TEXT,
 *   updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * );
 * 
 * CREATE TABLE IF NOT EXISTS subscriptions (
 *   id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
 *   user_id TEXT REFERENCES profiles(id) NOT NULL,
 *   status TEXT NOT NULL, -- 'active', 'canceled'
 *   plan_id TEXT NOT NULL, -- 'free', 'pro'
 *   paypal_subscription_id TEXT UNIQUE,
 *   created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
 *   updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
 * );
 * 
 * -- Enable RLS
 * ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
 * ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
 * 
 * -- Policies (Backend uses service_role, but these are good for frontend/anon access if needed)
 * -- Note: Since we use custom Google OAuth, these policies would need adjustment if using anon key.
 */
