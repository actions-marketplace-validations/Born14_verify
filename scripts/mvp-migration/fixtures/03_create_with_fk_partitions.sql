CREATE TABLE chats(
    id bigserial,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id)
    );

CREATE TABLE chat_messages(
    id bigserial,
    created_at timestamptz NOT NULL,
    chat_id bigint NOT NULL,
    chat_created_at timestamptz NOT NULL,
    message text NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (chat_id) REFERENCES chats(id)
    );

CREATE INDEX ON chats (created_at);
CREATE INDEX ON chat_messages (created_at);

CREATE SCHEMA app;
CREATE EXTENSION pg_cron;

CREATE TABLE app.chats(
    id bigserial,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (id, created_at)
    ) PARTITION BY RANGE (created_at);

CREATE INDEX "chats_created_at" ON app.chats (created_at);

CREATE TABLE app.chat_messages(
    id bigserial,
    created_at timestamptz NOT NULL,
    chat_id bigint NOT NULL,
    chat_created_at timestamptz NOT NULL,
    message text NOT NULL,
    PRIMARY KEY (id, created_at),
    FOREIGN KEY (chat_id, chat_created_at)
        REFERENCES app.chats(id, created_at)
    ) PARTITION BY RANGE (created_at);

CREATE INDEX "chat_messages_created_at" ON app.chat_messages (created_at);
CREATE INDEX "chat_messages_chat_id_chat_created_at"
    ON app.chat_messages (chat_id, chat_created_at);
