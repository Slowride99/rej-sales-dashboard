import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const { data, error } = await supabase.rpc('speaker_prospects', {
    p_market: req.query.market || 'TX',
    p_limit: Number(req.query.limit) || 50,
  });

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json(data);
}