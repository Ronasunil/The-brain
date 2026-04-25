-- ============================================
-- Migration 007: Add `card` JSONB to inbuilt_chat_messages
--
-- Bot replies can carry a structured payload (e.g. a Linear ticket card)
-- alongside the markdown `content`. The frontend renders the card when
-- present and falls back to `content` for older clients.
--
-- Run this in Supabase SQL Editor.
-- ============================================

ALTER TABLE inbuilt_chat_messages
  ADD COLUMN IF NOT EXISTS card JSONB;
