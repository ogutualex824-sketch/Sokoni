# Landlord rules — FIRST EXECUTION (JDK 21), 2026-08-02

Runner: Microsoft OpenJDK 21.0.12 (portable, C:\temp\jdk21). Emulator: firestore.
Result: **25 passed, 3 FAILED**. All three are "expected to fail, but it succeeded" —
the rules PERMIT what they must forbid.

## Failures — all three are access-control holes

1. **A landlord may approve their OWN building** — self-approval; bypasses admin moderation.
2. **Another landlord may add a unit to this building** — cross-account write.
3. **A tenant may raise a charge against THEMSELVES** — financial record forgery.

## Raw
```
  PASS  a landlord may create their own building
  PASS  a landlord may NOT self-publish (status must start pending)
  PASS  a landlord may NOT create a building owned by someone else
  FAIL  a landlord may NOT approve their own building   [Expected request to fail, but it succeeded.]
  PASS  an admin MAY moderate
  PASS  a landlord MAY edit their own building details
  PASS  ownerUid cannot be reassigned by its owner
  PASS  another landlord may NOT edit it
  PASS  the building directory is public to read
  PASS  owner may read their unit
  PASS  tenant may read their own unit
  PASS  another landlord may NOT read it
  PASS  the public may NOT read who lives there
  PASS  owner may add a unit
  FAIL  another landlord may NOT add a unit to this building   [Expected request to fail, but it succeeded.]
  PASS  a tenant may NOT change their own rent
  PASS  owner may raise a rent charge
  PASS  owner may settle a PENDING entry
  PASS  owner may NOT edit a PAID entry
  PASS  owner may NOT delete a ledger entry
  PASS  an unknown ledger type is rejected
  PASS  a non-numeric amount is rejected
  PASS  every approved type is accepted
  PASS  tenant may read their own ledger
  PASS  another landlord may NOT read this ledger
  FAIL  tenant may NOT raise a charge against themselves   [Expected request to fail, but it succeeded.]
  PASS  admin may delete a ledger entry
  PASS  admin may list buildings
```
