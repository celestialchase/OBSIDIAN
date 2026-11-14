import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after, before, beforeEach } from 'node:test';
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  setDoc,
  setLogLevel,
  updateDoc,
} from 'firebase/firestore';

const PROJECT_ID = 'buoyant-technique-4bvhw';
const firestoreRules = fs.readFileSync('firestore.rules', 'utf8');

let testEnv: RulesTestEnvironment;

function makePrefs(uid: string, overrides: Record<string, unknown> = {}) {
  return {
    uid,
    dyslexiaMode: true,
    focusMode: false,
    readingRuler: true,
    textToSpeech: false,
    highContrast: false,
    screenReader: false,
    biggerText: false,
    smallText: false,
    lineHeightEnabled: false,
    highlightLinks: false,
    textSpacingEnabled: false,
    hideImages: false,
    customCursor: false,
    darkMode: false,
    invertColors: false,
    fontFamily: 'atkinson',
    fontSizePercent: 110,
    lineSpacing: 1.6,
    letterSpacing: 0.04,
    wordSpacing: 0.08,
    paragraphSpacing: 1.4,
    contentWidth: 'standard',
    backgroundTheme: 'cream',
    ttsRate: 1.0,
    captionsEnabled: true,
    captionSize: 'md',
    captionBackground: 'dark',
    islPanelDefaultVisible: true,
    updatedAt: serverTimestamp(),
    ...overrides,
  };
}

function makeProfile(uid: string, email: string, role: 'student' | 'teacher' = 'student') {
  return {
    uid,
    name: `User ${uid}`,
    email,
    role,
    grade: 'Class 8',
    board: 'CBSE',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  };
}

before(async () => {
  setLogLevel('error');
  testEnv = await initializeTestEnvironment({
    projectId: PROJECT_ID,
    firestore: {
      rules: firestoreRules,
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

beforeEach(async () => {
  await testEnv.clearFirestore();
});

after(async () => {
  await testEnv.cleanup();
});

test('Unauthenticated users cannot read or write any private student data or ISL catalog', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'studentA'), makeProfile('studentA', 'a@example.com'));
    await setDoc(doc(db, 'islEntries', 'isl-1'), {
      id: 'isl-1',
      createdByUid: 'teacher1',
      term: 'Photosynthesis',
      category: 'Science terminology',
      meaning: 'Plants make food using sunlight.',
      handshapeGuide: 'Open hand rising upward.',
      usageExample: 'Leaves perform photosynthesis.',
      isVerifiedClip: true,
      verificationLabel: 'Verified Educator Clip',
      createdAt: serverTimestamp(),
    });
  });

  const anonDb = testEnv.unauthenticatedContext().firestore();
  await assertFails(getDoc(doc(anonDb, 'users', 'studentA')));
  await assertFails(getDoc(doc(anonDb, 'islEntries', 'isl-1')));
  await assertFails(getDocs(collection(anonDb, 'islEntries')));
  await assertFails(
    setDoc(doc(anonDb, 'users', 'anon1'), makeProfile('anon1', 'anon@example.com'))
  );
  await assertFails(
    setDoc(doc(anonDb, 'users', 'studentA', 'notes', 'note1'), {
      id: 'note1',
      uid: 'studentA',
      title: 'Note',
      subject: 'Science',
      content: 'Content',
      createdAtLabel: 'Today',
      createdAt: serverTimestamp(),
    })
  );
});

test('Email spoofing / unverified email accounts are blocked from creating profiles, subcollections, and ISL entries', async () => {
  const unverified = testEnv.authenticatedContext('unverified1', {
    email: 'unverified@example.com',
    email_verified: false,
  });
  const db = unverified.firestore();

  await assertFails(
    setDoc(doc(db, 'users', 'unverified1'), makeProfile('unverified1', 'unverified@example.com'))
  );

  // Even if profile exists, unverified token cannot write subcollections or ISL entries
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(
      doc(ctx.firestore(), 'users', 'unverified1'),
      makeProfile('unverified1', 'unverified@example.com')
    );
  });

  await assertFails(
    setDoc(
      doc(db, 'users', 'unverified1', 'preferences', 'accessibility'),
      makePrefs('unverified1')
    )
  );
  await assertFails(
    setDoc(doc(db, 'islEntries', 'isl-unverified'), {
      id: 'isl-unverified',
      createdByUid: 'unverified1',
      term: 'Atom',
      category: 'Science terminology',
      meaning: 'Smallest unit of matter.',
      handshapeGuide: 'Pinch index and thumb.',
      usageExample: 'An atom has a nucleus.',
      isVerifiedClip: false,
      verificationLabel: 'Student Submission (Pending Verification)',
      createdAt: serverTimestamp(),
    })
  );
});

test('Verified student CRUD succeeds for own profile, preferences, notes, progress, quizzes, doubts, notifications, and videoProgress', async () => {
  const studentA = testEnv.authenticatedContext('studentA', {
    email: 'studenta@example.com',
    email_verified: true,
  });
  const db = studentA.firestore();

  // Profile create + grade update
  await assertSucceeds(
    setDoc(doc(db, 'users', 'studentA'), makeProfile('studentA', 'studenta@example.com', 'student'))
  );
  await assertSucceeds(
    updateDoc(doc(db, 'users', 'studentA'), {
      grade: 'Class 9',
      updatedAt: serverTimestamp(),
    })
  );
  const profileSnap = await assertSucceeds(getDoc(doc(db, 'users', 'studentA')));
  assert.equal(profileSnap.exists(), true);
  assert.equal(profileSnap.data()?.grade, 'Class 9');

  // Accessibility preferences + read-back persistence check
  await assertSucceeds(
    setDoc(doc(db, 'users', 'studentA', 'preferences', 'accessibility'), makePrefs('studentA'))
  );
  await assertSucceeds(
    updateDoc(doc(db, 'users', 'studentA', 'preferences', 'accessibility'), {
      darkMode: true,
      fontSizePercent: 125,
      updatedAt: serverTimestamp(),
    })
  );
  const prefsSnap = await assertSucceeds(
    getDoc(doc(db, 'users', 'studentA', 'preferences', 'accessibility'))
  );
  assert.equal(prefsSnap.exists(), true);
  assert.equal(prefsSnap.data()?.darkMode, true);
  assert.equal(prefsSnap.data()?.fontSizePercent, 125);
  assert.equal(prefsSnap.data()?.dyslexiaMode, true);

  // Saved notes create + update + delete
  await assertSucceeds(
    setDoc(doc(db, 'users', 'studentA', 'notes', 'note-1'), {
      id: 'note-1',
      uid: 'studentA',
      title: 'Stomata Notes',
      subject: 'Science',
      content: 'Stomata regulate gas exchange in leaves.',
      createdAtLabel: 'Today',
      createdAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    updateDoc(doc(db, 'users', 'studentA', 'notes', 'note-1'), {
      title: 'Stomata Revision Notes',
      content: 'Stomata open and close using guard cells.',
    })
  );
  await assertSucceeds(getDocs(collection(db, 'users', 'studentA', 'notes')));

  // Lesson progress: in-progress -> completed allowed, reverting from completed denied
  await assertSucceeds(
    setDoc(doc(db, 'users', 'studentA', 'lessonProgress', 'lesson-1'), {
      lessonId: 'lesson-1',
      uid: 'studentA',
      courseId: 'course-sci-8',
      subject: 'Science',
      status: 'in-progress',
      updatedAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    updateDoc(doc(db, 'users', 'studentA', 'lessonProgress', 'lesson-1'), {
      status: 'completed',
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(
    updateDoc(doc(db, 'users', 'studentA', 'lessonProgress', 'lesson-1'), {
      status: 'in-progress',
      updatedAt: serverTimestamp(),
    })
  );

  // Quiz attempts: create valid, update denied, invalid score > total denied
  await assertSucceeds(
    setDoc(doc(db, 'users', 'studentA', 'quizAttempts', 'attempt-1'), {
      id: 'attempt-1',
      uid: 'studentA',
      subject: 'Science',
      topic: 'Photosynthesis',
      score: 3,
      total: 4,
      percent: 75,
      completedAtLabel: 'Today',
      createdAt: serverTimestamp(),
    })
  );
  await assertFails(
    updateDoc(doc(db, 'users', 'studentA', 'quizAttempts', 'attempt-1'), {
      score: 4,
    })
  );
  await assertFails(
    setDoc(doc(db, 'users', 'studentA', 'quizAttempts', 'attempt-bad'), {
      id: 'attempt-bad',
      uid: 'studentA',
      subject: 'Science',
      topic: 'Photosynthesis',
      score: 5,
      total: 4,
      percent: 100,
      completedAtLabel: 'Today',
      createdAt: serverTimestamp(),
    })
  );

  // Doubt threads: create + save flag update
  await assertSucceeds(
    setDoc(doc(db, 'users', 'studentA', 'doubtThreads', 'msg-1'), {
      id: 'msg-1',
      uid: 'studentA',
      role: 'assistant',
      content: 'Chlorophyll absorbs sunlight for photosynthesis.',
      mode: 'simple',
      subject: 'Science',
      saved: false,
      timestamp: '10:00 AM',
      source: 'gemini',
      createdAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    updateDoc(doc(db, 'users', 'studentA', 'doubtThreads', 'msg-1'), {
      saved: true,
    })
  );

  // Notifications: create + update read state
  await assertSucceeds(
    setDoc(doc(db, 'users', 'studentA', 'notifications', 'notif-1'), {
      id: 'notif-1',
      uid: 'studentA',
      read: false,
      updatedAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    updateDoc(doc(db, 'users', 'studentA', 'notifications', 'notif-1'), {
      read: true,
      updatedAt: serverTimestamp(),
    })
  );

  // Video progress: create + update valid timestamp; invalid currentSec > durationSec denied
  await assertSucceeds(
    setDoc(doc(db, 'users', 'studentA', 'videoProgress', 'vid-1'), {
      videoId: 'vid-1',
      uid: 'studentA',
      currentSec: 12,
      durationSec: 45,
      completed: false,
      updatedAt: serverTimestamp(),
    })
  );
  await assertSucceeds(
    updateDoc(doc(db, 'users', 'studentA', 'videoProgress', 'vid-1'), {
      currentSec: 45,
      durationSec: 45,
      completed: true,
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(
    setDoc(doc(db, 'users', 'studentA', 'videoProgress', 'vid-bad'), {
      videoId: 'vid-bad',
      uid: 'studentA',
      currentSec: 99,
      durationSec: 45,
      completed: false,
      updatedAt: serverTimestamp(),
    })
  );

  // Delete own note succeeds
  await assertSucceeds(deleteDoc(doc(db, 'users', 'studentA', 'notes', 'note-1')));
});

test('Cross-user isolation prevents studentB from reading or modifying studentA records and prevents self-assigned privilege escalation', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'studentA'), makeProfile('studentA', 'a@example.com'));
    await setDoc(doc(db, 'users', 'studentB'), makeProfile('studentB', 'b@example.com'));
    await setDoc(doc(db, 'users', 'studentA', 'notes', 'secret-note'), {
      id: 'secret-note',
      uid: 'studentA',
      title: 'Private Note',
      subject: 'Mathematics',
      content: 'Private study content.',
      createdAtLabel: 'Today',
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'users', 'studentA', 'notifications', 'n1'), {
      id: 'n1',
      uid: 'studentA',
      read: false,
      updatedAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'users', 'studentA', 'videoProgress', 'v1'), {
      videoId: 'v1',
      uid: 'studentA',
      currentSec: 10,
      durationSec: 45,
      completed: false,
      updatedAt: serverTimestamp(),
    });
    await setDoc(
      doc(db, 'users', 'studentA', 'preferences', 'accessibility'),
      makePrefs('studentA')
    );
    await setDoc(doc(db, 'users', 'studentA', 'lessonProgress', 'lesson-1'), {
      lessonId: 'lesson-1',
      uid: 'studentA',
      courseId: 'course-sci-8',
      subject: 'Science',
      status: 'completed',
      updatedAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'users', 'studentA', 'quizAttempts', 'attempt-1'), {
      id: 'attempt-1',
      uid: 'studentA',
      subject: 'Science',
      topic: 'Photosynthesis',
      score: 4,
      total: 4,
      percent: 100,
      completedAtLabel: 'Today',
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, 'users', 'studentA', 'doubtThreads', 'msg-1'), {
      id: 'msg-1',
      uid: 'studentA',
      role: 'assistant',
      content: 'Private AI response.',
      timestamp: '10:00 AM',
      createdAt: serverTimestamp(),
    });
  });

  const studentB = testEnv.authenticatedContext('studentB', {
    email: 'b@example.com',
    email_verified: true,
  });
  const dbB = studentB.firestore();

  // Cross-user read/list/write denied across profile & all student subcollections
  await assertFails(getDoc(doc(dbB, 'users', 'studentA')));
  await assertFails(getDoc(doc(dbB, 'users', 'studentA', 'preferences', 'accessibility')));
  await assertFails(
    updateDoc(doc(dbB, 'users', 'studentA', 'preferences', 'accessibility'), {
      darkMode: true,
    })
  );
  await assertFails(getDoc(doc(dbB, 'users', 'studentA', 'lessonProgress', 'lesson-1')));
  await assertFails(
    setDoc(doc(dbB, 'users', 'studentA', 'lessonProgress', 'lesson-2'), {
      lessonId: 'lesson-2',
      uid: 'studentA',
      courseId: 'course-sci-8',
      subject: 'Science',
      status: 'in-progress',
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(getDoc(doc(dbB, 'users', 'studentA', 'quizAttempts', 'attempt-1')));
  await assertFails(
    setDoc(doc(dbB, 'users', 'studentA', 'quizAttempts', 'attempt-2'), {
      id: 'attempt-2',
      uid: 'studentA',
      subject: 'Science',
      topic: 'Osmosis',
      score: 1,
      total: 1,
      percent: 100,
      completedAtLabel: 'Today',
      createdAt: serverTimestamp(),
    })
  );
  await assertFails(getDoc(doc(dbB, 'users', 'studentA', 'doubtThreads', 'msg-1')));
  await assertFails(
    updateDoc(doc(dbB, 'users', 'studentA', 'doubtThreads', 'msg-1'), { saved: true })
  );
  await assertFails(getDoc(doc(dbB, 'users', 'studentA', 'notes', 'secret-note')));
  await assertFails(getDocs(collection(dbB, 'users', 'studentA', 'notes')));
  await assertFails(
    updateDoc(doc(dbB, 'users', 'studentA', 'notes', 'secret-note'), { content: 'Hacked' })
  );
  await assertFails(deleteDoc(doc(dbB, 'users', 'studentA', 'notes', 'secret-note')));
  await assertFails(getDoc(doc(dbB, 'users', 'studentA', 'notifications', 'n1')));
  await assertFails(
    setDoc(doc(dbB, 'users', 'studentA', 'videoProgress', 'v1'), {
      videoId: 'v1',
      uid: 'studentA',
      currentSec: 30,
      durationSec: 45,
      completed: false,
      updatedAt: serverTimestamp(),
    })
  );

  // Student cannot self-assign teacher role on create or update, nor list all users, nor write /admins
  await assertFails(getDocs(collection(dbB, 'users')));
  await assertFails(
    setDoc(doc(dbB, 'users', 'studentC'), makeProfile('studentC', 'c@example.com', 'teacher'))
  );
  await assertFails(
    updateDoc(doc(dbB, 'users', 'studentB'), {
      role: 'teacher',
      updatedAt: serverTimestamp(),
    })
  );
  await assertFails(setDoc(doc(dbB, 'admins', 'studentB'), { uid: 'studentB' }));
});

test('ISL entry permissions enforce authenticated read, student pending-only submissions, and educator-only verification', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'studentA'), makeProfile('studentA', 'a@example.com', 'student'));
    await setDoc(doc(db, 'users', 'teacher1'), makeProfile('teacher1', 't@example.com', 'teacher'));
    await setDoc(doc(db, 'islEntries', 'isl-student'), {
      id: 'isl-student',
      createdByUid: 'studentA',
      term: 'Denominator',
      category: 'Mathematics terminology',
      meaning: 'Bottom number of a fraction.',
      handshapeGuide: 'Flat hand held below index finger.',
      usageExample: 'In 3/4, 4 is the denominator.',
      isVerifiedClip: false,
      verificationLabel: 'Student Submission (Pending Verification)',
      createdAt: serverTimestamp(),
    });
  });

  const dbStudentA = testEnv
    .authenticatedContext('studentA', { email: 'a@example.com', email_verified: true })
    .firestore();
  const dbStudentB = testEnv
    .authenticatedContext('studentB', { email: 'b@example.com', email_verified: true })
    .firestore();
  const dbTeacher = testEnv
    .authenticatedContext('teacher1', { email: 't@example.com', email_verified: true })
    .firestore();
  const dbAdmin = testEnv
    .authenticatedContext('admin1', { email: 'punsaini88@gmail.com', email_verified: true })
    .firestore();

  // Signed-in users can read & list ISL catalog
  await assertSucceeds(getDoc(doc(dbStudentB, 'islEntries', 'isl-student')));
  await assertSucceeds(getDocs(collection(dbStudentB, 'islEntries')));

  // Student CANNOT create a verified ISL entry
  await assertFails(
    setDoc(doc(dbStudentA, 'islEntries', 'isl-spoof-verified'), {
      id: 'isl-spoof-verified',
      createdByUid: 'studentA',
      term: 'Numerator',
      category: 'Mathematics terminology',
      meaning: 'Top number of a fraction.',
      handshapeGuide: 'Point upward.',
      usageExample: 'In 3/4, 3 is the numerator.',
      isVerifiedClip: true,
      verificationLabel: 'Verified Educator Clip',
      createdAt: serverTimestamp(),
    })
  );

  // Student CAN create an unverified pending submission
  await assertSucceeds(
    setDoc(doc(dbStudentA, 'islEntries', 'isl-pending-2'), {
      id: 'isl-pending-2',
      createdByUid: 'studentA',
      term: 'Numerator',
      category: 'Mathematics terminology',
      meaning: 'Top number of a fraction.',
      handshapeGuide: 'Point upward.',
      usageExample: 'In 3/4, 3 is the numerator.',
      isVerifiedClip: false,
      verificationLabel: 'Student Submission (Pending Verification)',
      createdAt: serverTimestamp(),
    })
  );

  // Student CANNOT escalate their own pending submission to verified
  await assertFails(
    updateDoc(doc(dbStudentA, 'islEntries', 'isl-student'), {
      isVerifiedClip: true,
      verificationLabel: 'Verified Educator Clip',
    })
  );

  // Another student CANNOT modify or delete studentA's entry
  await assertFails(
    updateDoc(doc(dbStudentB, 'islEntries', 'isl-student'), {
      meaning: 'Tampered',
    })
  );
  await assertFails(deleteDoc(doc(dbStudentB, 'islEntries', 'isl-student')));

  // Authorized teacher CAN verify student submission
  await assertSucceeds(
    updateDoc(doc(dbTeacher, 'islEntries', 'isl-student'), {
      isVerifiedClip: true,
      verificationLabel: 'Verified Educator Clip',
    })
  );

  // Once verified, student can no longer edit or delete it
  await assertFails(
    updateDoc(doc(dbStudentA, 'islEntries', 'isl-student'), {
      meaning: 'Edited after verification',
    })
  );
  await assertFails(deleteDoc(doc(dbStudentA, 'islEntries', 'isl-student')));

  // Admin can promote a user to teacher and delete ISL entries
  await assertSucceeds(
    updateDoc(doc(dbAdmin, 'users', 'studentA'), {
      role: 'teacher',
      updatedAt: serverTimestamp(),
    })
  );
  await assertSucceeds(deleteDoc(doc(dbAdmin, 'islEntries', 'isl-pending-2')));
});

test('Firestore blocks base64/blob media and legacy storagePath fields while allowing external HTTPS ISL video URLs', async () => {
  await testEnv.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users', 'studentA'), makeProfile('studentA', 'a@example.com', 'student'));
    await setDoc(doc(db, 'users', 'teacher1'), makeProfile('teacher1', 't@example.com', 'teacher'));
  });

  const dbStudentA = testEnv
    .authenticatedContext('studentA', { email: 'a@example.com', email_verified: true })
    .firestore();
  const dbTeacher = testEnv
    .authenticatedContext('teacher1', { email: 't@example.com', email_verified: true })
    .firestore();

  // Reject base64 data URI in doubtThreads.imagePreview
  await assertFails(
    setDoc(doc(dbStudentA, 'users', 'studentA', 'doubtThreads', 'msg-b64'), {
      id: 'msg-b64',
      uid: 'studentA',
      role: 'user',
      content: 'Explain this diagram',
      imagePreview: 'data:image/png;base64,AAAA',
      timestamp: '10:00 AM',
      createdAt: serverTimestamp(),
    })
  );

  // Reject legacy storagePath ghost field in doubtThreads
  await assertFails(
    setDoc(doc(dbStudentA, 'users', 'studentA', 'doubtThreads', 'msg-ghost'), {
      id: 'msg-ghost',
      uid: 'studentA',
      role: 'user',
      content: 'Explain this',
      storagePath: 'doubt-images/studentA/q1.png',
      timestamp: '10:00 AM',
      createdAt: serverTimestamp(),
    })
  );

  // Reject blob: and http:// URLs in islEntries.customVideoUrl
  await assertFails(
    setDoc(doc(dbTeacher, 'islEntries', 'isl-blob'), {
      id: 'isl-blob',
      createdByUid: 'teacher1',
      term: 'Osmosis',
      category: 'Science terminology',
      meaning: 'Movement of water across membrane.',
      handshapeGuide: 'Two palms facing.',
      usageExample: 'Roots absorb water by osmosis.',
      isVerifiedClip: true,
      verificationLabel: 'Verified External ISL Video',
      customVideoUrl: 'blob:https://indrasetu.edu/1234',
      createdAt: serverTimestamp(),
    })
  );
  await assertFails(
    setDoc(doc(dbTeacher, 'islEntries', 'isl-http'), {
      id: 'isl-http',
      createdByUid: 'teacher1',
      term: 'Osmosis',
      category: 'Science terminology',
      meaning: 'Movement of water across membrane.',
      handshapeGuide: 'Two palms facing.',
      usageExample: 'Roots absorb water by osmosis.',
      isVerifiedClip: true,
      verificationLabel: 'Verified External ISL Video',
      customVideoUrl: 'http://example.edu/isl/osmosis.mp4',
      createdAt: serverTimestamp(),
    })
  );
  await assertFails(
    setDoc(doc(dbTeacher, 'islEntries', 'isl-storage-field'), {
      id: 'isl-storage-field',
      createdByUid: 'teacher1',
      term: 'Osmosis',
      category: 'Science terminology',
      meaning: 'Movement of water across membrane.',
      handshapeGuide: 'Two palms facing.',
      usageExample: 'Roots absorb water by osmosis.',
      isVerifiedClip: true,
      verificationLabel: 'Verified External ISL Video',
      customVideoUrl: 'https://cdn.example.edu/isl/osmosis.mp4',
      storagePath: 'isl-videos/teacher1/osmosis.mp4',
      createdAt: serverTimestamp(),
    })
  );

  // Allow valid external HTTPS video URL
  await assertSucceeds(
    setDoc(doc(dbTeacher, 'islEntries', 'isl-https-ok'), {
      id: 'isl-https-ok',
      createdByUid: 'teacher1',
      term: 'Osmosis',
      category: 'Science terminology',
      meaning: 'Movement of water across a semi-permeable membrane.',
      handshapeGuide: 'Two palms facing.',
      usageExample: 'Roots absorb water by osmosis.',
      isVerifiedClip: true,
      verificationLabel: 'Verified External ISL Video',
      customVideoUrl: 'https://cdn.example.edu/isl/osmosis.mp4',
      createdAt: serverTimestamp(),
    })
  );
});

