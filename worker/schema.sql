-- Reiseberater – D1-Schema
-- Im Cloudflare Dashboard: Storage & Databases → D1 → reiseberater → Console
-- Inhalt einfügen und ausführen.

CREATE TABLE IF NOT EXISTS trips (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  ziel        TEXT,
  reiseart    TEXT,
  start_date  TEXT,
  end_date    TEXT,
  data        TEXT NOT NULL,   -- JSON: Profil, Angebot, Reiseführer, Notizen, Häkchen, Tipps
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_trips_start ON trips (start_date);

-- Präferenzen je Reiseart (paar, allein, allein_gruppe).
-- Legt der Worker beim ersten Aufruf auch selbst an.
CREATE TABLE IF NOT EXISTS prefs (
  reiseart    TEXT PRIMARY KEY,
  data        TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
