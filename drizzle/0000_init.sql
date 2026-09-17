CREATE TABLE `accounts` (
  `id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
  `host` text NOT NULL,
  `port` integer NOT NULL,
  `username` text NOT NULL,
  `tls_mode` text NOT NULL DEFAULT 'starttls',
  `reject_unauthorized` integer NOT NULL DEFAULT 1,
  `last_script` text,
  `password_enc` text,
  `last_used_at` integer
);
--> statement-breakpoint
CREATE TABLE `settings` (
  `id` integer PRIMARY KEY NOT NULL DEFAULT 1,
  `last_account_id` integer,
  `window_x` integer,
  `window_y` integer,
  `window_width` integer,
  `window_height` integer
);
--> statement-breakpoint
INSERT INTO `settings` (`id`) VALUES (1);
