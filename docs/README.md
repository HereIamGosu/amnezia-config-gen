# docs/

Project documentation (plans, specs, research, release process, protocol evidence).

## GitHub Pages

GitHub Pages is still enabled for this folder (Settings → Pages → Deploy from a branch → `main` → `/docs`),
but it publishes only `index.html`: an instant redirect to the official site https://awgconfig.com/
(cross-domain `canonical` + `meta refresh 0`). The former landing page competed with the main site in search
results as a duplicate. `_config.yml` keeps the internal documents out of the published site.

If GitHub Pages is no longer needed at all, it can be switched off in the repository settings; the redirect
keeps old links and search results working until the engines drop the github.io URL.
