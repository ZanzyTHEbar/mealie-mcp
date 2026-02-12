# Mealie MCP — Tool ranking for AI agents

Tools are ranked by relevance for an AI agent. Only **high**, **medium**, and **low** are exposed (in the registry and callable via `mealie_call`); **exclude** tools are filtered out and cannot be used.

Regenerate this file after changing ranking logic: `npm run dump-ranking`.

## Summary

| Relevance | Count | Exposed |
|-----------|-------|---------|
| high      | 81  | yes     |
| medium    | 67  | yes     |
| low       | 19   | yes     |
| exclude   | 80  | no      |
| **Total** | **247** | **167** |

## Excluded (not exposed)

These operations do not make logical sense for an AI agent: auth flows, admin, binary uploads, webhooks, migrations, etc.

| short_id | method | path | description |
|----------|--------|------|-------------|
| about_check_list | get | /api/admin/about/check | Check App Config... |
| about_startup_info_list | get | /api/app/about/startup-info | returns helpful startup information... |
| about_statistics_list | get | /api/admin/about/statistics | Get App Statistics... |
| about_theme_list | get | /api/app/about/theme | Get's the current theme settings... |
| admin_about_list | get | /api/admin/about | Get general application information... |
| admin_backup_delete | delete | /api/admin/backups/{file_name} | Delete One... |
| admin_backup_get | get | /api/admin/backups/{file_name} | Returns a token to download a file... |
| admin_backups_list | get | /api/admin/backups | Get All... |
| admin_backups_post | post | /api/admin/backups | Create One... |
| admin_email_list | get | /api/admin/email | Get general application information... |
| admin_email_post | post | /api/admin/email | Send Test Email... |
| admin_group_delete | delete | /api/admin/groups/{item_id} | Delete One... |
| admin_group_get | get | /api/admin/groups/{item_id} | Get One... |
| admin_group_put | put | /api/admin/groups/{item_id} | Update One... |
| admin_groups_list | get | /api/admin/groups | Get All... |
| admin_groups_post | post | /api/admin/groups | Create One... |
| admin_household_delete | delete | /api/admin/households/{item_id} | Delete One... |
| admin_household_get | get | /api/admin/households/{item_id} | Get One... |
| admin_household_put | put | /api/admin/households/{item_id} | Update One... |
| admin_households_list | get | /api/admin/households | Get All... |
| admin_households_post | post | /api/admin/households | Create One... |
| admin_maintenance_list | get | /api/admin/maintenance | Get the maintenance summary... |
| admin_user_delete | delete | /api/admin/users/{item_id} | Delete One... |
| admin_user_get | get | /api/admin/users/{item_id} | Get One... |
| admin_user_put | put | /api/admin/users/{item_id} | Update One... |
| admin_users_list | get | /api/admin/users | Get All... |
| admin_users_post | post | /api/admin/users | Create One... |
| app_about_list | get | /api/app/about | Get general application information... |
| auth_logout_post | post | /api/auth/logout | Logout... |
| auth_oauth_list | get | /api/auth/oauth | Oauth Login... |
| auth_refresh_list | get | /api/auth/refresh | Use a valid token to get another token... |
| auth_token_post | post | /api/auth/token | Get Token... |
| backups_restore_post | post | /api/admin/backups/{file_name}/restore | Import One... |
| backups_upload_post | post | /api/admin/backups/upload | Upload a .zip File to later be imported into Meali... |
| clean_images_post | post | /api/admin/maintenance/clean/images | Purges all the images from the filesystem that are... |
| clean_recipe_folders_post | post | /api/admin/maintenance/clean/recipe-folders | Deletes all the recipe folders that don't have nam... |
| clean_temp_post | post | /api/admin/maintenance/clean/temp | Clean Temp... |
| create_image_post | post | /api/recipes/create/image | Create a recipe from an image using OpenAI. Option... |
| create_zip_post | post | /api/recipes/create/zip | Create recipe from archive... |
| debug_openai_post | post | /api/admin/debug/openai | Debug Openai... |
| docker_validate_txt_list | get | /api/media/docker/validate.txt | Get Validation Text... |
| events_image_put | put | /api/recipes/timeline/events/{item_id}/image | Update Event Image... |
| events_notification_delete | delete | /api/households/events/notifications/{item_id} | Delete One... |
| events_notification_get | get | /api/households/events/notifications/{item_id} | Get One... |
| events_notification_put | put | /api/households/events/notifications/{item_id} | Update One... |
| events_notifications_list | get | /api/households/events/notifications | Get All... |
| events_notifications_post | post | /api/households/events/notifications | Create One... |
| groups_migrations_post | post | /api/groups/migrations | Start Data Migration... |
| groups_report_delete | delete | /api/groups/reports/{item_id} | Delete One... |
| groups_storage_list | get | /api/groups/storage | Get Storage... |
| households_recipe_action_delete | delete | /api/households/recipe-actions/{item_id} | Delete One... |
| households_recipe_action_get | get | /api/households/recipe-actions/{item_id} | Get One... |
| households_recipe_action_put | put | /api/households/recipe-actions/{item_id} | Update One... |
| households_recipe_actions_list | get | /api/households/recipe-actions | Get All... |
| households_recipe_actions_post | post | /api/households/recipe-actions | Create One... |
| households_webhook_delete | delete | /api/households/webhooks/{item_id} | Delete One... |
| households_webhook_get | get | /api/households/webhooks/{item_id} | Get One... |
| households_webhook_put | put | /api/households/webhooks/{item_id} | Update One... |
| households_webhooks_list | get | /api/households/webhooks | Get All... |
| households_webhooks_post | post | /api/households/webhooks | Create One... |
| maintenance_storage_list | get | /api/admin/maintenance/storage | Get Storage Details... |
| notifications_test_post | post | /api/households/events/notifications/{item_id}/test | Test Notification... |
| oauth_callback_list | get | /api/auth/oauth/callback | Oauth Callback... |
| recipe_actions_trigger_post | post | /api/households/recipe-actions/{item_id}/trigger/{recipe_slug} | Trigger Action... |
| recipes_image_post | post | /api/recipes/{slug}/image | Scrape Image Url... |
| recipes_image_put | put | /api/recipes/{slug}/image | Update Recipe Image... |
| seeders_foods_post | post | /api/groups/seeders/foods | Seed Foods... |
| seeders_labels_post | post | /api/groups/seeders/labels | Seed Labels... |
| seeders_units_post | post | /api/groups/seeders/units | Seed Units... |
| users_api_token_delete | delete | /api/users/api-tokens/{token_id} | Delete api_token from the Database... |
| users_api_tokens_post | post | /api/users/api-tokens | Create api_token in the Database... |
| users_forgot_password_post | post | /api/users/forgot-password | Sends an email with a reset link to the user... |
| users_image_post | post | /api/users/{id}/image | Updates a User Image... |
| users_password_reset_token_post | post | /api/admin/users/password-reset-token | Generates a reset token and returns it. This is an... |
| users_register_post | post | /api/users/register | Register New User... |
| users_reset_password_post | post | /api/users/reset-password | Resets the user password... |
| users_unlock_post | post | /api/admin/users/unlock | Unlock Users... |
| utils_download_list | get | /api/utils/download | Uses a file token obtained by an active user to re... |
| webhooks_rerun_post | post | /api/households/webhooks/rerun | Manually re-fires all previously scheduled webhook... |
| webhooks_test_post | post | /api/households/webhooks/{item_id}/test | Test One... |

## High relevance (core agent use)

| short_id | method | path | description |
|----------|--------|------|-------------|
| categories_empty_list | get | /api/organizers/categories/empty | Returns a list of categories that do not contain a |
| categories_slug_get | get | /api/organizers/categories/slug/{category_slug} | Returns a category object with the associated reci |
| food_delete | delete | /api/foods/{item_id} | Delete One |
| food_get | get | /api/foods/{item_id} | Get One |
| food_put | put | /api/foods/{item_id} | Update One |
| foods_list | get | /api/foods | Get All |
| foods_merge_put | put | /api/foods/merge | Merge One |
| foods_post | post | /api/foods | Create One |
| households_cookbook_delete | delete | /api/households/cookbooks/{item_id} | Delete One |
| households_cookbook_get | get | /api/households/cookbooks/{item_id} | Get One |
| households_cookbook_put | put | /api/households/cookbooks/{item_id} | Update One |
| households_cookbooks_list | get | /api/households/cookbooks | Get All |
| households_cookbooks_post | post | /api/households/cookbooks | Create One |
| households_cookbooks_put | put | /api/households/cookbooks | Update Many |
| households_mealplan_delete | delete | /api/households/mealplans/{item_id} | Delete One |
| households_mealplan_get | get | /api/households/mealplans/{item_id} | Get One |
| households_mealplan_put | put | /api/households/mealplans/{item_id} | Update One |
| households_mealplans_list | get | /api/households/mealplans | Get All |
| households_mealplans_post | post | /api/households/mealplans | Create One |
| households_members_list | get | /api/households/members | Returns all users belonging to the current househo |
| households_self_list | get | /api/households/self | Returns the Household Data for the Current User |
| items_create_bulk_post | post | /api/households/shopping/items/create-bulk | Create Many |
| lists_label_setting_put | put | /api/households/shopping/lists/{item_id}/label-settings | Update Label Settings |
| lists_recipe_post | post | /api/households/shopping/lists/{item_id}/recipe | Add Recipe Ingredients To List |
| lists_recipe_post_2 | post | /api/households/shopping/lists/{item_id}/recipe/{recipe_id} | Add Single Recipe Ingredients To List |
| mealplans_random_post | post | /api/households/mealplans/random | `create_random_meal` is a route that provides the  |
| mealplans_today_list | get | /api/households/mealplans/today | Get Todays Meals |
| organizers_categori_delete | delete | /api/organizers/categories/{item_id} | Removes a recipe category from the database. Delet |
| organizers_categori_get | get | /api/organizers/categories/{item_id} | Returns a list of recipes associated with the prov |
| organizers_categori_put | put | /api/organizers/categories/{item_id} | Updates an existing Tag in the database |
| organizers_categories_list | get | /api/organizers/categories | Returns a list of available categories in the data |
| organizers_categories_post | post | /api/organizers/categories | Creates a Category in the database |
| organizers_tag_delete | delete | /api/organizers/tags/{item_id} | Removes a recipe tag from the database. Deleting a |
| organizers_tag_get | get | /api/organizers/tags/{item_id} | Returns a list of recipes associated with the prov |
| organizers_tag_put | put | /api/organizers/tags/{item_id} | Updates an existing Tag in the database |
| organizers_tags_list | get | /api/organizers/tags | Returns a list of available tags in the database |
| organizers_tags_post | post | /api/organizers/tags | Creates a Tag in the database |
| organizers_tool_delete | delete | /api/organizers/tools/{item_id} | Delete One |
| organizers_tool_get | get | /api/organizers/tools/{item_id} | Get One |
| organizers_tool_put | put | /api/organizers/tools/{item_id} | Update One |
| organizers_tools_list | get | /api/organizers/tools | Get All |
| organizers_tools_post | post | /api/organizers/tools | Create One |
| parser_ingredient_post | post | /api/parser/ingredient | Parse Ingredient |
| parser_ingredients_post | post | /api/parser/ingredients | Parse Ingredients |
| recip_get | get | /api/recipes/{slug} | Takes in a recipe's slug or id and returns all dat |
| recipe_delete_post | post | /api/households/shopping/lists/{item_id}/recipe/{recipe_id}/delete | Remove Recipe Ingredients From List |
| recipes_comment_get | get | /api/recipes/{slug}/comments | Get all comments for a recipe |
| recipes_export_get | get | /api/recipes/{slug}/exports | ## Parameters `template_name`: The name of the tem |
| recipes_exports_list | get | /api/recipes/exports | Get Recipe Formats And Templates |
| recipes_list | get | /api/recipes | Get All |
| recipes_shared_get | get | /api/recipes/shared/{token_id} | Get Shared Recipe |
| recipes_suggestions_list | get | /api/recipes/suggestions | Suggest Recipes |
| self_favorites_list | get | /api/users/self/favorites | Get Logged In User Favorites |
| self_rating_get | get | /api/users/self/ratings/{recipe_id} | Get Logged In User Rating For Recipe |
| self_ratings_list | get | /api/users/self/ratings | Get Logged In User Ratings |
| self_recip_get | get | /api/households/self/recipes/{recipe_slug} | Returns recipe data for the current household |
| shared_zip_get | get | /api/recipes/shared/{token_id}/zip | Get a recipe and its original image as a Zip file |
| shopping_item_delete | delete | /api/households/shopping/items/{item_id} | Delete One |
| shopping_item_get | get | /api/households/shopping/items/{item_id} | Get One |
| shopping_item_put | put | /api/households/shopping/items/{item_id} | Update One |
| shopping_items_delete | delete | /api/households/shopping/items | Delete Many |
| shopping_items_list | get | /api/households/shopping/items | Get All |
| shopping_items_post | post | /api/households/shopping/items | Create One |
| shopping_items_put | put | /api/households/shopping/items | Update Many |
| shopping_list_delete | delete | /api/households/shopping/lists/{item_id} | Delete One |
| shopping_list_get | get | /api/households/shopping/lists/{item_id} | Get One |
| shopping_list_put | put | /api/households/shopping/lists/{item_id} | Update One |
| shopping_lists_list | get | /api/households/shopping/lists | Get All |
| shopping_lists_post | post | /api/households/shopping/lists | Create One |
| tags_empty_list | get | /api/organizers/tags/empty | Returns a list of tags that do not contain any rec |
| tags_slug_get | get | /api/organizers/tags/slug/{tag_slug} | Get One By Slug |
| timeline_event_get | get | /api/recipes/timeline/events/{item_id} | Get One |
| timeline_events_list | get | /api/recipes/timeline/events | Get All |
| tools_slug_get | get | /api/organizers/tools/slug/{tool_slug} | Get One By Slug |
| unit_delete | delete | /api/units/{item_id} | Delete One |
| unit_get | get | /api/units/{item_id} | Get One |
| unit_put | put | /api/units/{item_id} | Update One |
| units_list | get | /api/units | Get All |
| units_merge_put | put | /api/units/merge | Merge One |
| units_post | post | /api/units | Create One |
| users_self_list | get | /api/users/self | Get Logged In User |

## Medium relevance

| short_id | method | path | description |
|----------|--------|------|-------------|
| bulk_actions_categorize_post | post | /api/recipes/bulk-actions/categorize | Bulk Categorize Recipes |
| bulk_actions_delete_post | post | /api/recipes/bulk-actions/delete | Bulk Delete Recipes |
| bulk_actions_export_post | post | /api/recipes/bulk-actions/export | Bulk Export Recipes |
| bulk_actions_settings_post | post | /api/recipes/bulk-actions/settings | Bulk Settings Recipes |
| bulk_actions_tag_post | post | /api/recipes/bulk-actions/tag | Bulk Tag Recipes |
| create_html_or_json_post | post | /api/recipes/create/html-or-json | Takes in raw HTML or a https://schema.org/Recipe o |
| create_url_post | post | /api/recipes/create/url | Takes in a URL and attempts to scrape data and loa |
| export_purge_delete | delete | /api/recipes/bulk-actions/export/purge | Remove all exports data, including items on disk w |
| groups_cookbook_get | get | /api/explore/groups/{group_slug}/cookbooks | Get All |
| groups_cookbook_get_2 | get | /api/explore/groups/{group_slug}/cookbooks/{item_id} | Get One |
| groups_food_get | get | /api/explore/groups/{group_slug}/foods | Get All |
| groups_food_get_2 | get | /api/explore/groups/{group_slug}/foods/{item_id} | Get One |
| groups_household_get | get | /api/groups/households/{household_slug} | Get One Household |
| groups_household_get_2 | get | /api/explore/groups/{group_slug}/households | Get All |
| groups_household_get_3 | get | /api/explore/groups/{group_slug}/households/{household_slug} | Get Household |
| groups_households_list | get | /api/groups/households | Get All Households |
| groups_label_delete | delete | /api/groups/labels/{item_id} | Delete One |
| groups_label_get | get | /api/groups/labels/{item_id} | Get One |
| groups_label_put | put | /api/groups/labels/{item_id} | Update One |
| groups_labels_list | get | /api/groups/labels | Get All |
| groups_labels_post | post | /api/groups/labels | Create One |
| groups_member_get | get | /api/groups/members/{username_or_id} | Returns a single user belonging to the current gro |
| groups_members_list | get | /api/groups/members | Returns all users belonging to the current group |
| groups_preferences_list | get | /api/groups/preferences | Get Group Preferences |
| groups_preferences_put | put | /api/groups/preferences | Update Group Preferences |
| groups_recip_get | get | /api/explore/groups/{group_slug}/recipes | Get All |
| groups_recip_get_2 | get | /api/explore/groups/{group_slug}/recipes/{recipe_slug} | Get Recipe |
| groups_self_list | get | /api/groups/self | Returns the Group Data for the Current User |
| households_invitations_list | get | /api/households/invitations | Get Invite Tokens |
| households_invitations_post | post | /api/households/invitations | Create Invite Token |
| households_permissions_put | put | /api/households/permissions | Set Member Permissions |
| households_preferences_list | get | /api/households/preferences | Get Household Preferences |
| households_preferences_put | put | /api/households/preferences | Update Household Preferences |
| households_statistics_list | get | /api/households/statistics | Get Statistics |
| images_timeline_get | get | /api/media/recipes/{recipe_id}/images/timeline/{timeline_event_id}/{file_name} | Takes in a recipe id and event timeline id, return |
| invitations_email_post | post | /api/households/invitations/email | Email Invitation |
| organizers_categori_get_2 | get | /api/explore/groups/{group_slug}/organizers/categories | Get All |
| organizers_categori_get_3 | get | /api/explore/groups/{group_slug}/organizers/categories/{item_id} | Get One |
| organizers_tag_get_2 | get | /api/explore/groups/{group_slug}/organizers/tags | Get All |
| organizers_tag_get_3 | get | /api/explore/groups/{group_slug}/organizers/tags/{item_id} | Get One |
| organizers_tool_get_2 | get | /api/explore/groups/{group_slug}/organizers/tools | Get All |
| organizers_tool_get_3 | get | /api/explore/groups/{group_slug}/organizers/tools/{item_id} | Get One |
| recip_delete | delete | /api/recipes/{slug} | Deletes a recipe by slug |
| recip_patch | patch | /api/recipes/{slug} | Updates a recipe by existing slug and data. |
| recip_put | put | /api/recipes/{slug} | Updates a recipe by existing slug and data. |
| recipes_asset_get | get | /api/media/recipes/{recipe_id}/assets/{file_name} | Returns a recipe asset |
| recipes_asset_post | post | /api/recipes/{slug}/assets | Upload a file to store as a recipe asset |
| recipes_duplicate_post | post | /api/recipes/{slug}/duplicate | Duplicates a recipe with a new custom name if give |
| recipes_imag_get | get | /api/media/recipes/{recipe_id}/images/{file_name} | Takes in a recipe id, returns the static image. Th |
| recipes_image_delete | delete | /api/recipes/{slug}/image | Delete Recipe Image |
| recipes_last_made_patch | patch | /api/recipes/{slug}/last-made | Update a recipe's last made timestamp |
| recipes_patch | patch | /api/recipes | Patch Many |
| recipes_post | post | /api/recipes | Takes in a JSON string and loads data into the dat |
| recipes_put | put | /api/recipes | Update Many |
| recipes_suggestion_get | get | /api/explore/groups/{group_slug}/recipes/suggestions | Suggest Recipes |
| recipes_test_scrape_url_post | post | /api/recipes/test-scrape-url | Test Parse Recipe Url |
| timeline_event_delete | delete | /api/recipes/timeline/events/{item_id} | Delete One |
| timeline_event_put | put | /api/recipes/timeline/events/{item_id} | Update One |
| timeline_events_post | post | /api/recipes/timeline/events | Create One |
| url_bulk_post | post | /api/recipes/create/url/bulk | Takes in a URL and attempts to scrape data and loa |
| user_put | put | /api/users/{item_id} | Update User |
| users_favorit_delete | delete | /api/users/{id}/favorites/{slug} | Removes a recipe from the user's favorites |
| users_favorit_get | get | /api/users/{id}/favorites | Get user's favorited recipes |
| users_favorit_post | post | /api/users/{id}/favorites/{slug} | Adds a recipe to the user's favorites |
| users_password_put | put | /api/users/password | Resets the User Password |
| users_rating_get | get | /api/users/{id}/ratings | Get user's rated recipes |
| users_rating_post | post | /api/users/{id}/ratings/{slug} | Sets the user's rating for a recipe |

## Low relevance

| short_id | method | path | description |
|----------|--------|------|-------------|
| bulk_actions_export_list | get | /api/recipes/bulk-actions/export | Get Exported Data |
| comment_delete | delete | /api/comments/{item_id} | Delete One |
| comment_get | get | /api/comments/{item_id} | Get One |
| comment_put | put | /api/comments/{item_id} | Update One |
| comments_list | get | /api/comments | Get All |
| comments_post | post | /api/comments | Create One |
| export_download_get | get | /api/recipes/bulk-actions/export/{export_id}/download | Returns a token to download a file |
| groups_report_get | get | /api/groups/reports/{item_id} | Get One |
| groups_reports_list | get | /api/groups/reports | Get All |
| mealplans_rul_delete | delete | /api/households/mealplans/rules/{item_id} | Delete One |
| mealplans_rul_get | get | /api/households/mealplans/rules/{item_id} | Get One |
| mealplans_rul_put | put | /api/households/mealplans/rules/{item_id} | Update One |
| mealplans_rules_list | get | /api/households/mealplans/rules | Get All |
| mealplans_rules_post | post | /api/households/mealplans/rules | Create One |
| media_user_get | get | /api/media/users/{user_id}/{file_name} | Takes in a recipe slug, returns the static image.  |
| shared_recip_delete | delete | /api/shared/recipes/{item_id} | Delete One |
| shared_recip_get | get | /api/shared/recipes/{item_id} | Get One |
| shared_recipes_list | get | /api/shared/recipes | Get All |
| shared_recipes_post | post | /api/shared/recipes | Create One |
