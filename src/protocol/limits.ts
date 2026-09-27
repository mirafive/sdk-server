// Vendored from mirafive/protocol 5037788489cb. Do not edit; run bun run vendor:protocol.
export const PROTOCOL_VERSION = 1
export const DEFAULT_HOST = "https://events.mirafive.io"

export const MAX_BODY_BYTES = 1_048_576
export const MAX_EVENTS = 1000
export const MAX_REPORTED_ERRORS = 10

export const MAX_NAME_LENGTH = 128
export const MAX_URL_LENGTH = 2048
export const MAX_TITLE_LENGTH = 512
export const MAX_REFERRER_LENGTH = 2048
export const MAX_ID_LENGTH = 256
export const MAX_SDK_NAME_LENGTH = 64
export const MAX_SDK_VERSION_LENGTH = 32
export const MIN_LOCALE_LENGTH = 2
export const MAX_LOCALE_LENGTH = 35
export const MAX_TIMEZONE_LENGTH = 64
export const MAX_SCREEN_SIZE = 32_768

export const MAX_PROPERTIES_BYTES = 32_768
export const MAX_PROPERTY_LEAVES = 64
export const MAX_PROPERTY_DEPTH = 5
export const MAX_PROPERTY_KEY_LENGTH = 128

export const MAX_LOOKUP_UNITS = 100
export const MAX_LOOKUP_BODY_BYTES = 1024

export const RESERVED_NAMES = [
  "$pageview",
  "$autocapture",
  "$identify",
  "$search",
  "$install_check",
  "$exposure"
] as const

export const FULL_ONLY_NAMES = ["$identify", "$search", "$exposure"] as const

export const KEPT_QUERY_PARAMETERS = [
  "ref",
  "source",
  "gclid",
  "gbraid",
  "wbraid",
  "fbclid",
  "msclkid",
  "ttclid",
  "li_fat_id"
] as const
