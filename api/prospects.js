import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  const market = req.query.market || 'TX';

  const { data, error } = await supabase
    .from('company_signals')
    .select('*')
    .eq('market', market)
    .neq('key', '__internal__')
    .order('attendee_count', { ascending: false })
    .limit(100);

  if (error) return res.status(500).json({ error: error.message });
  res.status(200).json(data);
}