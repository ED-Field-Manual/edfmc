# Deep Core Mining Helper

Surfaces the EDFM mining pages at the two moments they are actually useful,
rather than making you go looking for them.

## What it does

**When you prospect a core asteroid** — a `ProspectedAsteroid` event that
reports a `MotherlodeMaterial` — you get links to the core mining and abrasion
blaster pages for four minutes.

**When you dock somewhere with a Material Trader**, you get the material
trading page for fifteen minutes.

## Why you might see nothing

Both rules are conditional. Prospecting an ordinary asteroid does not trigger
the first, and a station without a Material Trader does not trigger the second.
That is normal — the Plugins screen lists both rules by name so you can tell
the plugin is installed and working even when it is silent.

## Changing it

Edit `plugin.json` and press **Reload plugins**. No restart. If you break the
JSON, the Plugins screen will tell you what is wrong rather than the plugin
quietly vanishing.
