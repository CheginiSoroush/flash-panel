# :material-playlist-check:{ .md .middle } DNS over HTTPS (DoH)

As most famous public DoH servers are blocked by firewalls, Flash Panel exposes its own DoH endpoint on the worker using domain fronting. The endpoint is:

```
https://<your-domain>/<securePath>/dns-query
```

It proxies DNS queries to the **Underlying DoH URL** configured in the panel (`dohUrl`, default `https://cloudflare-dns.com/dns-query`), with response caching, request coalescing and stale fallback.

## RFC 8484 wireformat only

The endpoint implements **RFC 8484 only** — the binary `application/dns-message` wire format:

- **GET** with the DNS query base64url-encoded in the `dns` parameter.
- **POST** with the raw DNS message as the body and `Content-Type: application/dns-message`.

JSON-based APIs (like `https://dns.google/resolve`) are a different protocol and are **not** supported — a JSON-style query is never answered with JSON, and anything outside `GET`/`POST` returns `405 Method Not Allowed` with an `Allow: GET, POST` header.

### GET example

```bash
# Build a wire-format query for "example.com IN A" (RD=1), base64url-encoded
Q=$(python3 - <<'EOF'
import base64
query = bytes.fromhex('000001000001000000000000') \
      + b'\x07example\x03com\x00' + bytes.fromhex('00010001')
print(base64.urlsafe_b64encode(query).rstrip(b'=').decode())
EOF
)

curl -s "https://<your-domain>/<securePath>/dns-query?dns=$Q" \
     -H 'accept: application/dns-message' -o reply.bin
```

### POST example

```bash
curl -s "https://<your-domain>/<securePath>/dns-query" \
     -H 'content-type: application/dns-message' \
     --data-binary @query.bin -o reply.bin
```

The response ID is rewritten to match your query's ID, so cached answers work for every requester.

## Caching and the `X-DNS-Cache` header

Every response carries an `X-DNS-Cache` header describing where the answer came from:

| Value | Meaning |
| --- | --- |
| `MISS` | Fetched from the upstream DoH and cached. |
| `HIT` | Served from cache. Identical questions from different clients share one cache entry (keyed by `qname|qtype`, not by query ID). |
| `STALE` | Upstream failed — an expired cached copy was served to keep DNS available. |
| `BYPASS` | The body was not a parseable wireformat message; the query was passed through untouched. |

Caching details: TTL is the minimum answer TTL clamped to 10–300 seconds, negative answers (NXDOMAIN/NODATA) are cached for 30 seconds, the LRU cache holds up to 256 entries, and concurrent identical queries are single-flighted into one upstream fetch. The cache lives in the isolate's memory only — it resets on deploy and is cleared when the underlying DoH URL changes.

## Client configuration

Point any RFC 8484 client at your endpoint:

- **Browsers**: Firefox/Chrome custom DoH URL `https://<your-domain>/<securePath>/dns-query`.
- **Android DoH apps** such as Intra or Rethink: add the same URL as a custom resolver.

!!! warning
    Avoid using your own Flash Panel DoH as the panel's `remoteDNS`, otherwise you will waste worker requests (and risk a loop). It is best used in browsers or DoH-based clients like Intra, Rethink, etc.

!!! note
    Only RFC 8484 upstream servers can be configured as the Underlying DoH URL — it must look like `https://domain-or-ip/dns-query`.
