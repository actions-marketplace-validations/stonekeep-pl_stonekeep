# Classification rules

The built-in rules are in
[`packages/core/rules/default-rules.json`](../core/rules/default-rules.json). A rules file looks
like this:

```json
{
  "version": 1,
  "ignore": ["^(is|has)_", "_(verified|count)$"],
  "typeAdjustments": { "boolean": -0.5 },
  "rules": [
    {
      "id": "email",
      "category": "contact",
      "description": "Email addresses.",
      "match": [
        { "pattern": "^(.*_)?e_?mail(_address)?$", "confidence": 0.95 },
        { "pattern": "(^|_)e_?mail(_|$)", "confidence": 0.8 }
      ],
      "exclude": [],
      "formats": ["email"],
      "formatConfidence": 0.98,
      "typeAdjustments": {}
    }
  ]
}
```

| Field              | Meaning                                                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ |
| `ignore`           | Patterns. A name that matches one is never classified by name (it can still match by `format`)   |
| `typeAdjustments`  | Score change per coarse type: `string`, `number`, `boolean`, `date`, `json`, `binary`, `unknown` |
| `rules[].match`    | Regexes tested against the **normalized** name. The highest matching confidence is used          |
| `rules[].exclude`  | A name that matches one of these is skipped for this rule                                        |
| `rules[].formats`  | JSON Schema / OpenAPI `format` values that trigger the rule                                      |
| `rules[].category` | Any lowercase snake_case string. You can define your own categories                              |

Normalization lowercases the name and converts it to snake_case:

- `phoneNumber` becomes `phone_number`
- `IPAddress` becomes `ip_address`
- `user-email` becomes `user_email`

## Built-in categories

`contact`, `identity`, `government_id`, `financial`, `location`, `online_identifier`, `demographic`,
`special_category`, `health`, `credential`.

## Languages

Besides English, the `cee-*` rules match Polish (`pesel`, `nr_dowodu`, `imie`, `nazwisko`,
`adres_zamieszkania`), Romanian (`cnp`, `serie_buletin`, `prenume`, `domiciliu`) and Hungarian
(`adoazonosito_jel`, `taj_szam`, `vezeteknev`, `lakcim`) field names, plus national IDs from
Czechia and Slovakia (`rodne_cislo`), Bulgaria (`egn`), Croatia (`oib`), Slovenia (`emso`) and the
Baltics. Names are folded to ASCII before matching, so `imię`, `születési_dátum` and `reședință`
match too.

## Customising

There are three ways to customise classification in `stonekeep.config.json`:

- **Add or replace individual rules.** Use `extraRules`. A rule with an existing `id` replaces the
  built-in rule.
- **Replace the whole rule set.** Set `"rulesFile": "path/to/rules.json"`.
- **Decide individual fields.** Use `overrides`, for example
  `{ "users.handle": { "ignore": true, "note": "..." } }`.

Notes in overrides are committed to your repository and appear in code review, so don't put
personal data in them.
