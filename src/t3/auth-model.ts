import * as Schema from 'effect/Schema'

const Secret = Schema.RedactedFromValue(Schema.NonEmptyString)
const Timestamp = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))

// Existing sessions can still launch tasks; new pairing also requests clone permission.
export const requiredScopes = ['orchestration:read', 'orchestration:operate']
export const pairingScopes = [...requiredScopes, 'source-control:write']

export const Credential = Schema.Struct({
  version: Schema.Literal(1),
  origin: Schema.NonEmptyString,
  accessToken: Secret,
  expiresAt: Timestamp,
  renewAt: Timestamp,
  scope: Schema.NonEmptyString,
})
export interface Credential extends Schema.Schema.Type<typeof Credential> {}
export const credentialJson = Schema.fromJsonString(Credential)
export const decodeCredential = Schema.decodeUnknownEffect(credentialJson)
export const encodeCredential = Schema.encodeEffect(credentialJson)

export const TokenResponse = Schema.Struct({
  access_token: Secret,
  issued_token_type: Schema.Literal('urn:ietf:params:oauth:token-type:access_token'),
  token_type: Schema.Literal('Bearer'),
  expires_in: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  scope: Schema.NonEmptyString,
})
export const PairingResponse = Schema.Struct({
  credential: Secret,
  expiresAt: Schema.DateTimeUtc,
})
export const TicketResponse = Schema.Struct({
  ticket: Secret,
  expiresAt: Schema.DateTimeUtc,
})

// Deliberately omit transport causes: requests and malformed bodies can contain secrets.
export class AuthError extends Schema.TaggedError<AuthError>()('AuthError', {
  operation: Schema.String,
  reason: Schema.Literals([
    'transport',
    'rejected',
    'invalid-credential',
    'scope-not-granted',
    'invalid-response',
    'missing-scopes',
    'manual-pairing-required',
  ]),
  status: Schema.optionalKey(Schema.Finite),
}) {}

export class CredentialError extends Schema.TaggedError<CredentialError>()('CredentialError', {
  operation: Schema.String,
  reason: Schema.Literals([
    'io',
    'unsafe-permissions',
    'invalid-data',
    'wrong-server',
    'already-running',
  ]),
}) {}
