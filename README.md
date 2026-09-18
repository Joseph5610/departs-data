# departs-data — published data

Generated output, served at https://data.departs.app.

This branch holds **exactly one commit**. Each nightly workflow rebuilds its own city, amends that
commit and force-pushes, so the repository never accumulates history for data that is regenerated
daily and has no historical value.

Do not commit here by hand, and do not branch from it — the commit is replaced every night.
The build scripts and their history live on `master`.
