ALTER TABLE conversations
    ADD COLUMN ai_sentiment   VARCHAR(20)    NULL AFTER closed_at,
    ADD COLUMN ai_summary     TEXT           NULL AFTER ai_sentiment,
    ADD COLUMN ai_intent      VARCHAR(255)   NULL AFTER ai_summary,
    ADD COLUMN ai_quality     DECIMAL(4,2)   NULL AFTER ai_intent,
    ADD COLUMN ai_analyzed_at DATETIME       NULL AFTER ai_quality;
