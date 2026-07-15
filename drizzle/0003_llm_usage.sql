-- Custom SQL migration: llm_usage — daily spend accounting for the Housekeeper.
CREATE TABLE llm_usage (
  day date PRIMARY KEY,
  input_tokens bigint NOT NULL DEFAULT 0,
  output_tokens bigint NOT NULL DEFAULT 0,
  cost_micros bigint NOT NULL DEFAULT 0
);
