#!/usr/bin/env python3
"""Validador de correos - version script local.

Aplica la cascada de validacion sin dependencias externas: resuelve DNS
llamando a `dig`, que ya viene en macOS y Linux.

No determina si un buzon existe. Determina si una direccion es imposible
o sospechosa. La existencia real solo la confirma un envio.

Uso:
    python3 validate.py correos.txt
    python3 validate.py juan@gmail.com maria@gmial.com
    python3 validate.py correos.txt --json
"""

import json
import re
import subprocess
import sys

TIER1 = {
    "gmail.com", "hotmail.com", "outlook.com", "yahoo.com", "live.com",
    "icloud.com", "hotmail.es", "outlook.es", "yahoo.es",
}

COMMON_DOMAINS = TIER1 | {
    # ymail/rocketmail son dominios reales de Yahoo y quedan a distancia 1
    # de gmail.com: sin este anclaje exacto se "corregirian" por error.
    "ymail.com", "rocketmail.com",
    "me.com", "aol.com", "msn.com", "protonmail.com", "proton.me",
    "gmx.com", "zoho.com", "yandex.com", "mail.com", "live.com.mx",
    "hotmail.com.mx", "yahoo.com.mx", "hotmail.com.co", "yahoo.com.co",
    "outlook.com.co", "live.com.co", "une.net.co", "etb.net.co",
    "telmex.net.co", "hotmail.co.uk", "yahoo.com.ar", "hotmail.com.ar",
}

DISPOSABLE = {
    "mailinator.com", "10minutemail.com", "guerrillamail.com", "tempmail.com",
    "temp-mail.org", "yopmail.com", "throwawaymail.com", "trashmail.com",
    "sharklasers.com", "getnada.com", "maildrop.cc", "dispostable.com",
    "fakeinbox.com", "mailnesia.com", "spamgourmet.com", "emailondeck.com",
    "moakt.com", "tempr.email", "correotemporal.org", "mohmal.com",
    "grr.la", "guerrillamail.info", "mailcatch.com", "tempmailo.com",
}

ROLE_PREFIXES = {
    "info", "ventas", "admin", "contacto", "soporte", "ayuda", "hola",
    "noreply", "no-reply", "sales", "support", "billing", "facturacion",
    "gerencia", "rrhh", "marketing", "webmaster", "postmaster", "abuse",
    "contact", "team", "office", "administracion", "comercial", "pedidos",
}

JUNK_LOCAL = {
    "asdf", "asd", "asdfasdf", "test", "testing", "prueba", "pruebas", "aaa",
    "aaaa", "qwerty", "noexiste", "nada", "ninguno", "xxx", "xx", "abc",
    "123", "1234", "sdfsdf", "ejemplo", "example", "fake", "falso", "none",
    "na", "sinemail", "nomail", "correo",
}

PROVIDERS = [
    ("protection.outlook.com", "microsoft", True),
    ("outlook.com", "microsoft", True),
    ("google.com", "google", False),
    ("googlemail.com", "google", False),
    ("yahoodns.net", "yahoo", False),
    ("icloud.com", "apple", False),
    ("apple.com", "apple", False),
    ("zoho.com", "zoho", None),
    ("secureserver.net", "godaddy", None),
    ("mail.ru", "mailru", None),
    ("yandex.net", "yandex", None),
]

SYNTAX_RE = re.compile(r"^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$")

_dns_cache = {}


def edit_distance(a, b):
    """Damerau-Levenshtein: cuenta la transposicion como UN solo error.

    Levenshtein a secas le da distancia 2 a gmial/gmail y hotmial/hotmail,
    que son justo los typos mas frecuentes. Con transposicion valen 1.
    """
    if a == b:
        return 0
    la, lb = len(a), len(b)
    d = [[0] * (lb + 1) for _ in range(la + 1)]
    for i in range(la + 1):
        d[i][0] = i
    for j in range(lb + 1):
        d[0][j] = j
    for i in range(1, la + 1):
        for j in range(1, lb + 1):
            cost = 0 if a[i - 1] == b[j - 1] else 1
            d[i][j] = min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
            if i > 1 and j > 1 and a[i - 1] == b[j - 2] and a[i - 2] == b[j - 1]:
                d[i][j] = min(d[i][j], d[i - 2][j - 2] + 1)
    return d[la][lb]


def dig(name, rtype):
    """Devuelve (status, [respuestas]). status: NOERROR/NXDOMAIN/SERVFAIL/ERROR."""
    try:
        proc = subprocess.run(
            ["dig", "+time=3", "+tries=1", name, rtype],
            capture_output=True, text=True, timeout=12,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return "ERROR", []

    out = proc.stdout
    m = re.search(r"status:\s*([A-Z]+)", out)
    status = m.group(1) if m else "ERROR"

    answers, in_answer = [], False
    for line in out.splitlines():
        if line.startswith(";; ANSWER SECTION"):
            in_answer = True
            continue
        if in_answer:
            if not line.strip() or line.startswith(";;"):
                break
            parts = line.split()
            if len(parts) >= 5 and parts[3] == rtype:
                answers.append(" ".join(parts[4:]))
    return status, answers


def resolve(domain):
    if domain in _dns_cache:
        hit = dict(_dns_cache[domain])
        hit["cached"] = True
        return hit

    status, mx = dig(domain, "MX")
    result = {"cached": False, "mx_found": False, "mx_record": None,
              "null_mx": False, "dns_error": False}

    if status in ("SERVFAIL", "ERROR"):
        result["dns_error"] = True
    elif status == "NXDOMAIN":
        pass
    elif mx:
        hosts = [p.split()[-1].rstrip(".").lower() for p in mx if p.split()]
        if hosts == [""]:
            result["null_mx"] = True
        else:
            result["mx_found"] = True
            result["mx_record"] = sorted(
                mx, key=lambda r: int(r.split()[0]) if r.split()[0].isdigit() else 99
            )[0].split()[-1].rstrip(".").lower()
    else:
        a_status, a = dig(domain, "A")
        if a_status in ("SERVFAIL", "ERROR"):
            result["dns_error"] = True
        elif a:
            result["mx_found"] = True
            result["mx_record"] = None  # sin MX, entrega por registro A (RFC 5321)

    _dns_cache[domain] = dict(result)
    return result


def detect_provider(mx_record):
    if not mx_record:
        return None, None
    for suffix, name, catch_all in PROVIDERS:
        if mx_record.endswith(suffix):
            return name, catch_all
    return None, None


def find_typo(domain):
    """Devuelve (sugerencia, es_typo_alta_confianza)."""
    if domain in COMMON_DOMAINS:
        return None, False
    limit = 1 if len(domain) <= 6 else 2
    best, best_d = None, 99
    for cand in sorted(COMMON_DOMAINS):
        d = edit_distance(domain, cand)
        if d < best_d:
            best, best_d = cand, d
    if best_d > limit:
        return None, False
    return best, (best_d == 1 and best in TIER1)


def validate(raw):
    out = {
        "email": raw, "normalized": None, "status": None, "sub_status": None,
        "recommendation": None, "suggestion": None, "account": None,
        "domain": None, "role_based": False, "disposable": False,
        "mx_found": False, "mx_record": None, "smtp_provider": None,
        "catch_all": None, "cached": False, "notes": [],
    }

    # 1. Normalizar
    email = raw.strip().lower()
    if "@" in email:
        local, _, domain = email.rpartition("@")
        stripped = local.strip(".")
        if stripped != local:
            out["notes"].append("leading_period_removed")
            local = stripped
        email = f"{local}@{domain}"
    out["normalized"] = email

    # 2. Sintaxis
    if (email.count("@") != 1 or ".." in email or len(email) > 254
            or not SYNTAX_RE.match(email)):
        out.update(status="invalid", sub_status="failed_syntax_check",
                   recommendation="reject")
        return out

    local, _, domain = email.rpartition("@")
    out["account"], out["domain"] = local, domain

    if len(local) > 64:
        out.update(status="invalid", sub_status="failed_syntax_check",
                   recommendation="reject")
        return out

    # 3. Desechable. Va antes que la basura del local part: un hecho del
    #    dominio es mas confiable que una heuristica sobre el nombre.
    if domain in DISPOSABLE:
        out.update(status="do_not_mail", sub_status="disposable",
                   recommendation="reject", disposable=True)
        return out

    # 4. Local part basura
    if local in JUNK_LOCAL:
        out.update(status="invalid", sub_status="junk_local_part",
                   recommendation="reject")
        return out

    # 5. Typo
    suggestion, high_confidence = find_typo(domain)
    if suggestion:
        out["suggestion"] = f"{local}@{suggestion}"
    if high_confidence:
        out.update(status="invalid", sub_status="possible_typo",
                   recommendation="reject")
        return out

    # 6. DNS
    dns = resolve(domain)
    out["cached"] = dns["cached"]
    out["mx_found"] = dns["mx_found"]
    out["mx_record"] = dns["mx_record"]

    if dns["dns_error"]:
        out.update(status="unknown", sub_status="dns_unreachable",
                   recommendation="confirm")
        return out
    if dns["null_mx"]:
        out.update(status="invalid", sub_status="does_not_accept_mail",
                   recommendation="reject")
        return out
    if not dns["mx_found"]:
        out.update(status="invalid", recommendation="reject",
                   sub_status="possible_typo" if suggestion else "no_dns_entries")
        return out

    # 7-8. Proveedor y catch-all
    provider, catch_all = detect_provider(dns["mx_record"])
    out["smtp_provider"], out["catch_all"] = provider, catch_all

    # 9. Cuenta de rol
    if local in ROLE_PREFIXES:
        out.update(status="do_not_mail", sub_status="role_based",
                   recommendation="manual_review", role_based=True)
        return out

    # 10. Veredicto
    if catch_all:
        out.update(status="catch_all", recommendation="confirm")
    elif suggestion:
        out.update(status="valid", sub_status="possible_typo",
                   recommendation="confirm")
    else:
        out.update(status="valid", recommendation="accept")
    return out


def main():
    flags = {"--json", "--ok", "--no"}
    argv = [a for a in sys.argv[1:] if a not in flags]
    as_json = "--json" in sys.argv
    only_ok = "--ok" in sys.argv
    only_bad = "--no" in sys.argv

    if not argv:
        print(__doc__)
        return 1

    emails = []
    for arg in argv:
        try:
            with open(arg) as fh:
                emails += [ln.strip() for ln in fh if ln.strip()
                           and not ln.startswith("#")]
        except OSError:
            emails.append(arg)

    results = [validate(e) for e in emails]

    if as_json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
        return 0

    # Solo las direcciones, una por linea, para redirigir a un archivo.
    if only_ok:
        for r in results:
            if r["recommendation"] in ("accept", "confirm"):
                print(r["normalized"])
        return 0
    if only_bad:
        for r in results:
            if r["recommendation"] not in ("accept", "confirm"):
                sug = f'  # {r["sub_status"]}'
                sug += f' -> {r["suggestion"]}' if r["suggestion"] else ""
                print(f'{r["email"]}{sug}')
        return 0

    width = max((len(r["email"]) for r in results), default=20)
    icons = {"accept": "OK  ", "confirm": "?   ", "manual_review": "REV ",
             "reject": "NO  "}
    for r in results:
        line = (f'{icons.get(r["recommendation"], "    ")} '
                f'{r["email"]:<{width}}  {r["status"]}'
                f'{"/" + r["sub_status"] if r["sub_status"] else ""}')
        if r["suggestion"]:
            line += f'  -> {r["suggestion"]}'
        if r["normalized"] and r["normalized"] != r["email"].strip().lower():
            line += f'  (usar: {r["normalized"]})'
        print(line)

    print()
    counts = {}
    for r in results:
        counts[r["recommendation"]] = counts.get(r["recommendation"], 0) + 1
    total = len(results)
    summary = "  ".join(f"{k}: {v}" for k, v in sorted(counts.items()))
    print(f"{total} direcciones   {summary}")
    sendable = counts.get("accept", 0) + counts.get("confirm", 0)
    print(f"Enviables: {sendable}   Descartadas: {total - sendable}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
