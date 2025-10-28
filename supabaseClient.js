// supabaseClient.js
const SUPABASE_URL = "https://hsxtmzweqasetzfhzopn.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImhzeHRtendlcWFzZXR6Zmh6b3BuIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NjEzNTY0ODEsImV4cCI6MjA3NjkzMjQ4MX0.jxja4aulHU_oAghJlRjqpLObw4OFiLnMqL8o2wCSAOw";

const options = {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true, // Used for OAuth redirects
  },
};

export const sb = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  options
);