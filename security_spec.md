# IndraSetu AI — Firestore & Ephemeral Media Security Specification

> **Architecture Note**: IndraSetu AI operates **without Firebase Cloud Storage**. Student profiles, accessibility preferences, learning progress, assessments, saved notes, and AI chat text history live in Cloud Firestore. Doubt images and speech-to-text audio files are processed ephemerally in-session via secure server-side Gemini endpoints (`/api/ai/doubt` and `/api/speech/transcribe`) and are **never** uploaded to cloud object storage or persisted as base64 payloads inside Firestore. ISL video references use verified external `https://` URLs.

## 1. Data Invariants
1. **Default-Deny Catch-All**: All paths default to `allow read, write: if false;` unless explicitly matched.
2. **Owner-Only PII Isolation (`/users/{userId}`)**: A user profile containing email, name, and role can only be read (`get`), created, or updated by `request.auth.uid == userId` (or a verified bootstrapped admin). Blanket `list` queries on `/users` are strictly forbidden (`allow list: if false;`) to prevent scraping student/teacher PII.
3. **Immutable Ownership & Timestamps**: `uid`, `createdByUid`, and `createdAt` cannot be modified after creation. All `createdAt` fields must equal `request.time` on create; `updatedAt` must equal `request.time` on create/update.
4. **Privilege Escalation Prevention**: A user cannot escalate their `role` arbitrarily during profile updates (`update` action on `/users/{userId}` restricts affected keys to `['name', 'grade', 'updatedAt']` for non-admin owners).
5. **Path ID Poisoning Guard**: Every document ID (`userId`, `prefId`, `noteId`, `lessonId`, `attemptId`, `messageId`, `notifId`, `videoId`, `entryId`) must satisfy `isValidId(id)` (`^[a-zA-Z0-9_\-]+$`, max 128 chars).
6. **Subcollection Parent Gate**: Writes to `/users/{userId}/notes`, `lessonProgress`, `quizAttempts`, `doubtThreads`, `notifications`, `videoProgress`, and `preferences` verify `request.auth.uid == userId`, `email_verified == true`, strict key allowlists (`hasAll` + `hasOnly`), and volumetric size bounds on every string and array.
7. **Authenticated ISL Catalog (`/islEntries/{entryId}`)**: Authenticated users may read (`get`, `list`) the ISL catalog. Creation requires verified email (`email_verified == true`) with `createdByUid == request.auth.uid`. Only verified teachers or admins can set or modify `isVerifiedClip: true`. Optional `customVideoUrl` must be an external `https://` URL (`size <= 2000`) with no whitespace, rejecting `blob:`, `data:`, and `http://`.
8. **No Base64 / Large Media in Firestore**: `doubtThreads.imagePreview` (if ever supplied) must match `^https://.+$` (`size <= 2000`), blocking `data:` base64 payloads and `blob:` URIs. Legacy `storagePath` ghost fields are rejected across all collections.
9. **Server-Side Ephemeral AI & Speech Processing**: All `/api/ai/*` and `/api/speech/transcribe` endpoints verify a Firebase ID token (`email_verified: true`) before invoking Gemini and return explicit errors on unsupported file formats or sizes without persisting uploaded media bytes.

## 2. Adversarial "Dirty Dozen" Payloads (Expected: `PERMISSION_DENIED`)
1. Unauthenticated `get` on `/users/student-1` or `/islEntries/isl-1` -> DENIED.
2. Authenticated `student-A` attempting `get` or `list` on `/users/student-B/notes` -> DENIED.
3. Authenticated `student-A` attempting `create` on `/users/student-A` with `role: "teacher"` -> DENIED (`role == 'student' || isAdmin()`).
4. Authenticated `student-A` attempting `update` on `/users/student-A` changing `role: "teacher"` -> DENIED (`affectedKeys` excludes `role`).
5. Authenticated `student-A` injecting ghost field `storagePath` on `doubtThreads` or `islEntries` -> DENIED (`hasOnly` check).
6. Authenticated `student-A` attempting to persist a `data:image/png;base64,...` URI in `doubtThreads.imagePreview` -> DENIED (`^https://.+$`).
7. Authenticated `student-A` attempting to save `blob:` or `http://` in `islEntries.customVideoUrl` -> DENIED (`^https://.+$`).
8. Authenticated `student-A` spoofing `uid: "student-B"` inside `/users/student-A/notes/n1` -> DENIED (`data.uid == request.auth.uid`).
9. Authenticated `student-A` spoofing `createdAt` to a past timestamp instead of `request.time` -> DENIED.
10. Oversized string attack (5KB title on `SavedNote`, or 2KB `noteId`) -> DENIED (`size()` + `isValidId()`).
11. Unverified email (`email_verified == false`) attempting to write profiles, notes, or `islEntries` -> DENIED.
12. `student-A` attempting to self-verify `isVerifiedClip: true` on `islEntries` or edit another user's entry -> DENIED.
