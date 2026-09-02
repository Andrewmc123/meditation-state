/**
 * Selectable characters, and the emotes each one can perform.
 *
 * Two kinds of emote, because the free rigs do not all ship the same clips:
 *
 *  - CLIP emotes play an animation that came with the model. RobotExpressive
 *    has a proper set (Dance, Sitting, Wave, ThumbsUp, Jump); the Mixamo-rigged
 *    humans have only a handful.
 *
 *  - POSE emotes are authored here as bone rotations and blended onto whatever
 *    the skeleton is currently doing. They exist because the poses this project
 *    actually needs - sitting cross-legged, lying down, floating in lotus - are
 *    not in any of the free clip sets, and because a pose costs nothing to add
 *    once the bone names are known.
 *
 * Pose emotes require the Mixamo naming convention, so they are offered on the
 * two human rigs and not on the robot, which uses its own skeleton.
 */

export const CHARACTERS = {
  xbot: {
    name: 'Astra',
    file: 'models/Xbot.glb',
    skeleton: 'mixamo',
    note: 'Neutral human rig. Best with the wardrobe.',
    scale: 1,
    locomotion: { idle: 'idle', walk: 'walk', run: 'run' },
    clipEmotes: {
      agree: { label: 'Nod', clip: 'agree' },
      refuse: { label: 'Shake head', clip: 'headShake' },
      sneak: { label: 'Creep', clip: 'sneak_pose', hold: true },
      downcast: { label: 'Downcast', clip: 'sad_pose', hold: true },
    },
  },
  soldier: {
    name: 'Vega',
    file: 'models/Soldier.glb',
    skeleton: 'mixamo',
    note: 'Heavier build. Fewer clips, all poses available.',
    scale: 1,
    locomotion: { idle: 'Idle', walk: 'Walk', run: 'Run' },
    clipEmotes: {},
  },
  robot: {
    name: 'Kepler',
    file: 'models/RobotExpressive.glb',
    skeleton: 'robot',
    note: 'Full emote set. Its own skeleton, so no custom poses.',
    scale: 0.42,   // authored far larger than a human
    locomotion: { idle: 'Idle', walk: 'Walking', run: 'Running' },
    clipEmotes: {
      dance: { label: 'Dance', clip: 'Dance' },
      wave: { label: 'Wave', clip: 'Wave' },
      sit: { label: 'Sit', clip: 'Sitting', hold: true },
      stand: { label: 'Stand tall', clip: 'Standing', hold: true },
      yes: { label: 'Yes', clip: 'Yes' },
      no: { label: 'No', clip: 'No' },
      thumbsUp: { label: 'Thumbs up', clip: 'ThumbsUp' },
      jump: { label: 'Leap', clip: 'Jump' },
    },
  },
};

/**
 * Authored poses, in radians, as {boneName: [x, y, z]} euler offsets applied
 * on top of the rig's bind pose.
 *
 * `root` rotates and lifts the whole body, which is how lying down works
 * without needing a lying-down clip: the skeleton holds a relaxed pose and the
 * root tips it onto its back.
 */
export const POSES = {
  meditate: {
    label: 'Meditate',
    note: 'Cross-legged. Hands resting on the knees.',
    root: { rot: [0, 0, 0], y: -0.42 },   // sink to sitting height
    bones: {
      mixamorigLeftUpLeg:   [-1.42, 0.30, -0.95],
      mixamorigRightUpLeg:  [-1.42, -0.30, 0.95],
      mixamorigLeftLeg:     [2.05, 0, 0],
      mixamorigRightLeg:    [2.05, 0, 0],
      mixamorigLeftArm:     [0.28, 0, -1.28],
      mixamorigRightArm:    [0.28, 0, 1.28],
      mixamorigLeftForeArm: [0, 0, -0.52],
      mixamorigRightForeArm:[0, 0, 0.52],
      mixamorigSpine:       [0.06, 0, 0],
      mixamorigSpine1:      [0.04, 0, 0],
      mixamorigHead:        [0.10, 0, 0],
    },
  },
  lie: {
    label: 'Lie down',
    note: 'Flat on your back. Try it facing the sky.',
    root: { rot: [-1.5708, 0, 0], y: -0.86 },
    bones: {
      mixamorigLeftArm:     [0, 0, -0.62],
      mixamorigRightArm:    [0, 0, 0.62],
      mixamorigLeftForeArm: [0, 0, -0.18],
      mixamorigRightForeArm:[0, 0, 0.18],
      mixamorigLeftUpLeg:   [0.06, 0, -0.10],
      mixamorigRightUpLeg:  [0.06, 0, 0.10],
      mixamorigHead:        [0.20, 0, 0],
    },
  },
  float: {
    label: 'Float',
    note: 'Lotus, untethered. For space.',
    root: { rot: [-0.22, 0, 0], y: 0 },
    bones: {
      mixamorigLeftUpLeg:   [-1.36, 0.34, -1.02],
      mixamorigRightUpLeg:  [-1.36, -0.34, 1.02],
      mixamorigLeftLeg:     [2.20, 0, 0],
      mixamorigRightLeg:    [2.20, 0, 0],
      mixamorigLeftArm:     [0.10, 0, -1.42],
      mixamorigRightArm:    [0.10, 0, 1.42],
      mixamorigLeftForeArm: [0, 0, -0.30],
      mixamorigRightForeArm:[0, 0, 0.30],
      mixamorigHead:        [-0.06, 0, 0],
    },
  },
  bow: {
    label: 'Bow',
    note: 'A gassho. Hands together at the chest.',
    root: { rot: [0.30, 0, 0], y: 0 },
    bones: {
      mixamorigLeftArm:     [0, 0, -1.05],
      mixamorigRightArm:    [0, 0, 1.05],
      mixamorigLeftForeArm: [0, -0.55, -1.35],
      mixamorigRightForeArm:[0, 0.55, 1.35],
      mixamorigSpine1:      [0.24, 0, 0],
      mixamorigHead:        [0.30, 0, 0],
    },
  },
  reach: {
    label: 'Reach',
    note: 'Both arms up. For when the view deserves it.',
    root: { rot: [-0.10, 0, 0], y: 0 },
    bones: {
      mixamorigLeftArm:     [0, 0, 1.15],
      mixamorigRightArm:    [0, 0, -1.15],
      mixamorigLeftForeArm: [0, 0, 0.22],
      mixamorigRightForeArm:[0, 0, -0.22],
      mixamorigSpine1:      [-0.14, 0, 0],
      mixamorigHead:        [-0.24, 0, 0],
    },
  },
};

/** Emotes available to a given character, clip and pose alike. */
export function emotesFor(charKey) {
  const c = CHARACTERS[charKey];
  if (!c) return [];
  const out = [];
  for (const [k, e] of Object.entries(c.clipEmotes)) {
    out.push({ key: k, label: e.label, kind: 'clip', hold: !!e.hold });
  }
  if (c.skeleton === 'mixamo') {
    for (const [k, p] of Object.entries(POSES)) {
      out.push({ key: k, label: p.label, kind: 'pose', note: p.note });
    }
  }
  return out;
}
