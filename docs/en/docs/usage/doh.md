# :material-playlist-check:{ .md .middle } DNS over HTTPS (DoH)

As most of famous public DoH servers are blocked by firewalls, we can use domain fronting to successfully use them. Flash Panel DoH only supports RFC 8484 standard DoH servers which typically are in `https://domain/dns-query` format. For example Google has two types of DoH `https://dns.google/dns-query` which is RFC 8484 and `https://dns.google/resolve` which is JSON API. Flash Panel only supports the first type.

!!! warning
    Avoid using Flash Panel DoH for `remote DNS` in panel, otherwise you will waste your worker requests. It's better be use in browsers or DoH based clients like Intra, Rethink...
