CREATE TABLE `style_categories` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `style_categories_owner_name_unique` ON `style_categories` (`owner_id`,`name`);--> statement-breakpoint
ALTER TABLE `conversation_settings` ADD `style_category_id` text REFERENCES style_categories(id);--> statement-breakpoint
ALTER TABLE `style_corpora` ADD `category_id` text REFERENCES style_categories(id);
--> statement-breakpoint
ALTER TABLE `style_corpora` DROP COLUMN `contact_label`;
