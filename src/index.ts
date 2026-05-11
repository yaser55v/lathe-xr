/* https://www.cgtrader.com/free-3d-models/industrial/industrial-machine/automatic-double-station-lathe-loading-and-unloading-machine?utm_source=credit_item_page */
import {
  AssetManifest,
  AssetType,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PlaneGeometry,
  BoxGeometry,
  Box3,
  Vector3,
  SessionMode,
  SRGBColorSpace,
  AssetManager,
  World,
  Object3D,
  // Lighting
  AmbientLight,
  DirectionalLight,
  SpotLight,
  HemisphereLight,
  // Renderer enums
  ACESFilmicToneMapping,
  PCFShadowMap,
} from "@iwsdk/core";
import { signal } from "@preact/signals-core";

import {
  Interactable,
  PanelUI,
} from "@iwsdk/core";

import { EnvironmentType, LocomotionEnvironment, IBLTexture, DomeTexture, PanelDocument } from "@iwsdk/core";
import * as horizonKit from "@pmndrs/uikit-horizon";

import { Handwheel, HandwheelSystem } from "./handwheel.js";
import { Door, DoorSystem } from "./door.js";

import { createSystem, eq } from "@iwsdk/core";
import type { Component as UIKitComponent } from "@pmndrs/uikit";

export class MainMenuSystem extends createSystem({
  menu: {
    required: [PanelUI, PanelDocument],
    where: [eq(PanelUI, "config", "./ui/main-menu.json")],
  },
}) {
  init() {
    this.queries.menu.subscribe("qualify", (entity) => {
      const doc = entity.getValue(PanelDocument, "document") as { getElementById(id: string): UIKitComponent | null };
      if (!doc) return;

      const xrButton = doc.getElementById("xr-button");
      if (xrButton) {
        xrButton.setProperties({
          onClick: () => {
            this.world.enterXR();
            entity.object3D!.visible = false;
          },
        });
      }
    });
  }
}

const assets: AssetManifest = {
  chimeSound: {
    url: "./audio/chime.mp3",
    type: AssetType.Audio,
    priority: "background",
  },
  new_lathe: {
    url: "./gltf/new-one.glb",
    type: AssetType.GLTF,
    priority: "critical",
  },
  machineShop: {
    url: "./textures/autoshop_01_1k.hdr",
    type: AssetType.HDRTexture,
    priority: "background",
  },
};

World.create(document.getElementById("scene-container") as HTMLDivElement, {
  assets,
  xr: {
    sessionMode: SessionMode.ImmersiveVR,
    offer: "always",
    // Optional structured features; layers/local-floor are offered by default
    features: { handTracking: true, layers: true },
  },
  render: {
    // Disable SDK default gradient so our custom rig takes full control
    defaultLighting: false,
  },
  features: {
    locomotion: { useWorker: true },
    grabbing: true,
    physics: false,
    sceneUnderstanding: false,
    environmentRaycast: false,
    spatialUI: {
      kits: [horizonKit],
    },
  },
}).then((world) => {
  const { camera, renderer } = world;
  (world.globals as Record<string, unknown>).uiLanguage = signal<"it" | "en">("it");

  // ── Renderer: cinematic tone mapping + shadow maps ────────────────────────
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = PCFShadowMap;
  renderer.toneMapping = ACESFilmicToneMapping;
  // Adjusted exposure for balance
  renderer.toneMappingExposure = 1.1;

  // ── Environment: HDR as both background dome and IBL source ──────────────
  const levelRoot = world.activeLevel.value;
  levelRoot.addComponent(IBLTexture, {
    src: "machineShop",
    // Keep IBL at full strength — it is the primary driver of gloss/reflections
    // on PBR metallic surfaces, matching how Blender's environment lighting works
    intensity: 0.2,
    rotation: [0, Math.PI / 2, 0],
  });
  levelRoot.addComponent(DomeTexture, {
    src: "machineShop",
    rotation: [0, Math.PI / 4, 0],
  });

  camera.position.set(0, 1.6, 2);
  camera.lookAt(0, 1, -1);

  // Create a ground for locomotion
  const ground = new Mesh(
    new PlaneGeometry(100, 100),
    new MeshBasicMaterial({ visible: false }),
  );
  ground.rotateX(-Math.PI / 2);
  world
    .createTransformEntity(ground)
    .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

  const { scene: newLatheMesh } = AssetManager.getGLTF("new_lathe")!;

  // Bounding box center — used to position all lights relative to the machine
  const machineBBox = new Box3();
  const machineCenter = new Vector3();
  const machineSize = new Vector3();

  if (newLatheMesh) {

    newLatheMesh.position.y = -2; // bring the lathe closer to the ground

    world.createTransformEntity(newLatheMesh);

    // ── Enable shadow casting/receiving on every mesh in the GLB ─────────────
    newLatheMesh.traverse((child: any) => {
      if (child.isMesh) {
        child.castShadow = true;
        child.receiveShadow = true;
      }
    });

    // Find the lathe specifically (ignoring the room) for the collision box
    let latheSpecificObject: Object3D = newLatheMesh;
    let doorObject: Object3D | null = null;
    let automaticObject: Object3D | null = null;

    newLatheMesh.traverse((child: Object3D) => {
      if (child.name === "Sketchfab_model") {
        latheSpecificObject = child;
      }
      // Check for door (case-insensitive)
      if (child.name.toUpperCase().includes("DOOR")) {
        doorObject = child;
      }
      // Check for "Automatic" part
      if (child.name.toUpperCase().includes("AUTOMATIC")) {
        automaticObject = child;
      }
    });

    // Fix: If Automatic is not a child of the door, attach it so it moves with the door
    if (doorObject && automaticObject) {
      (doorObject as any).attach(automaticObject);
    }

    if (doorObject) {
      // We found the door! 
      // Compute its world position/size to create a matching invisible hitbox.
      // This avoids reparenting the door mesh, which was causing the "up" position jump.
      const doorBox = new Box3().setFromObject(doorObject);
      const doorSize = new Vector3();
      doorBox.getSize(doorSize);
      const doorCenter = new Vector3();
      doorBox.getCenter(doorCenter);

      const doorHitbox = new Mesh(
        new BoxGeometry(doorSize.x, doorSize.y, doorSize.z),
        new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false })
      );
      doorHitbox.position.copy(doorCenter);
      doorHitbox.name = "DoorHitbox";
      doorHitbox.userData = { doorObject };

      world.createTransformEntity(doorHitbox)
        .addComponent(Interactable)
        .addComponent(Door, {
          slideDistance: 4,
          slideAxis: [-1, 0, 0] // Moves left (Right -> Left)
        });
    }

    // Compute bounding box for light positioning
    machineBBox.setFromObject(latheSpecificObject);
    machineBBox.getCenter(machineCenter);
    machineBBox.getSize(machineSize);

    // Create an invisible proxy box for Locomotion (collision) to avoid the mergeGeometries crash
    const modelSize = new Vector3();
    const modelCenter = new Vector3();
    machineBBox.getSize(modelSize);
    machineBBox.getCenter(modelCenter);

    const collisionBox = new Mesh(
      new BoxGeometry(modelSize.x, modelSize.y, modelSize.z),
      new MeshBasicMaterial({ visible: false })
    );
    collisionBox.name = "LatheCollisionProxy";
    collisionBox.position.copy(modelCenter);

    world
      .createTransformEntity(collisionBox)
      .addComponent(LocomotionEnvironment, { type: EnvironmentType.STATIC });

    // ── Fix flat/gray materials on the tailstock ─────────────────────────────
    const tailstockParts = [
      "MeshBody1_0_325",
      "Object_166", "Object_167", "Object_168", "Object_169",
      "Object_170", "Object_171", "Object_172"
    ];

    newLatheMesh.traverse((child: any) => {
      if (child.isMesh && tailstockParts.includes(child.name)) {
        // 1. Fix the "2D flat" look by generating proper normals
        if (child.geometry) {
          child.geometry.computeVertexNormals();
        }

        // 2. Assign a shiny metallic blue material to match the rest of the lathe
        child.material = new MeshStandardMaterial({
          color: 0x31465e, // Dark machinery blue
          roughness: 0.4,
          metalness: 0.3,
          envMapIntensity: 1.5, // Match Blender gloss level
        });
      }
    });

    // ── Restore Blender-matching gloss on all GLB materials ──────────────────
    // GLTF exports do not carry envMapIntensity. Blender's Filmic pipeline
    // renders reflections stronger than Three.js defaults, so we boost it here.
    newLatheMesh.traverse((child: any) => {
      if (child.isMesh && child.material) {
        const mats = Array.isArray(child.material)
          ? child.material
          : [child.material];
        for (const mat of mats) {
          if (mat.isMeshStandardMaterial) {
            // 1.5 approximates the extra reflection strength visible in Blender
            mat.envMapIntensity = 1.5;
          }
        }
      }
    });
  }

  // ── 6-Point Studio Lighting Rig ───────────────────────────────────────────
  // All positions are relative to machineCenter (falls back to world origin
  // if the model didn't load, which avoids a crash).
  const cx = machineCenter.x;
  const cy = machineCenter.y;
  const cz = machineCenter.z;
  const span = Math.max(machineSize.length(), 4); // minimum spread of 4 m

  // 1. AMBIENT BASE — very low fill, avoids pitch-black crevices
  const ambientLight = new AmbientLight(0xffffff, 0.2);
  world.createTransformEntity(ambientLight);

  // 2. KEY LIGHT — warm white, upper-left, primary illumination, casts shadows
  const keyLight = new DirectionalLight(0xfff8eb, 3.5);
  keyLight.position.set(cx - span * 1.2, cy + span * 1.5, cz + span * 0.8);
  keyLight.target.position.set(cx, cy, cz);
  keyLight.castShadow = true;
  keyLight.shadow.mapSize.width = 512;
  keyLight.shadow.mapSize.height = 512;
  keyLight.shadow.camera.near = 0.5;
  keyLight.shadow.camera.far = span * 3;
  keyLight.shadow.camera.left = -span * 1.5;
  keyLight.shadow.camera.right = span * 1.5;
  keyLight.shadow.camera.top = span * 1.5;
  keyLight.shadow.camera.bottom = -span * 1.5;
  keyLight.shadow.bias = -0.001;
  keyLight.shadow.normalBias = 0.02;
  world.createTransformEntity(keyLight);
  world.createTransformEntity(keyLight.target);

  // 3. FILL LIGHT — cool white, right side, medium-low, softens key shadows
  const fillLight = new DirectionalLight(0xd9e8ff, 1.2);
  fillLight.position.set(cx + span * 1.4, cy + span * 0.6, cz + span * 0.4);
  fillLight.target.position.set(cx, cy, cz);
  world.createTransformEntity(fillLight);
  world.createTransformEntity(fillLight.target);

  // 4. RIM / BACK LIGHT — cool white, behind machine, creates edge separation
  const rimLight = new DirectionalLight(0xe6f0ff, 1.8);
  rimLight.position.set(cx + span * 0.3, cy + span * 1.0, cz - span * 1.6);
  rimLight.target.position.set(cx, cy, cz);
  world.createTransformEntity(rimLight);
  world.createTransformEntity(rimLight.target);

  // 5. GROUND BOUNCE — blue-gray hemisphere simulates factory floor bounce
  const groundBounce = new HemisphereLight(
    0xcdd9e6, // sky color (ceiling tint)
    0x3a4a5c, // ground color (floor bounce)
    0.5,
  );
  groundBounce.position.set(cx, cy - span * 0.5, cz);
  world.createTransformEntity(groundBounce);

  // 6. TOP FACTORY LIGHT — pure white downlight, simulates ceiling skylight
  //    (RectAreaLight skipped for WebXR perf — DirectionalLight from top instead)
  const topLight = new DirectionalLight(0xffffff, 1.4);
  topLight.position.set(cx, cy + span * 2.2, cz);
  topLight.target.position.set(cx, cy, cz);
  world.createTransformEntity(topLight);
  world.createTransformEntity(topLight.target);

  // 7. ROBOTIC ARM ACCENT — warm amber spotlight draws attention to hero element
  const armAccent = new SpotLight(0xffebbb, 4.0);
  armAccent.angle = Math.PI / 9;      // ~20° cone
  armAccent.penumbra = 0.35;          // soft edge
  armAccent.decay = 2.0;              // physically correct falloff
  armAccent.distance = span * 4;
  armAccent.castShadow = false;       // save shadow budget
  // Position upper-right of machine (robotic arm side)
  armAccent.position.set(cx + span * 0.8, cy + span * 1.3, cz + span * 0.5);
  armAccent.target.position.set(cx + span * 0.3, cy + span * 0.3, cz - span * 0.2);
  world.createTransformEntity(armAccent);
  world.createTransformEntity(armAccent.target);

  // ── Find the wheel inside the GLTF scene ─────────────────────────────────
  // IMPORTANT: We must NOT call createTransformEntity on a GLTF child directly
  // because the SDK would reparent it, removing it from the GLTF hierarchy.
  // Instead: find the object, compute its world bounding box, then create a
  // separate invisible hitbox entity at that position for interaction.
  let wheelObject: Object3D | null = null;
  newLatheMesh.traverse((child: Object3D) => {
    if (child.name === "Object_179") {
      wheelObject = child;
    }
  });

  if (wheelObject) {
    // Compute the world-space bounding box of the wheel mesh
    const box = new Box3().setFromObject(wheelObject as Object3D);
    const size = new Vector3();
    box.getSize(size);
    const center = new Vector3();
    box.getCenter(center);

    // Create an invisible hitbox mesh at the wheel's world center
    const hitboxMesh = new Mesh(
      new BoxGeometry(size.x, size.y, size.z),
      new MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false }),
    );
    hitboxMesh.name = "HandwheelHitbox";
    hitboxMesh.position.copy(center);

    // Pass the actual wheel object to the system via userData
    hitboxMesh.userData = { wheelObject };

    // This entity does NOT disturb the GLTF hierarchy
    world
      .createTransformEntity(hitboxMesh)
      .addComponent(Interactable)
      .addComponent(Handwheel);
  } else {
    console.warn("[Handwheel] ❌ Object_179 not found in GLTF!");
  }


  // ── Handwheel inspection panel ────────────────────────────────────────────
  // Positioned slightly to the right of and above the handwheel.
  // HandwheelSystem now animates and expands this single card in place.
  const inspectionPanel = world.createTransformEntity();
  inspectionPanel.object3D!.name = "InspectionPanel";
  inspectionPanel.addComponent(PanelUI, {
    config: "./ui/handwheel.json",
    maxHeight: 1.02,
    maxWidth: 1.18,
  });
  // Note: Interactable removed as PanelUI handles internal raycasting automatically
  inspectionPanel.object3D!.position.set(1.08, 1.95, -3.0);
  inspectionPanel.object3D!.visible = false;

  // ── Main Menu ─────────────────────────────────────────────────────────────
  const mainMenu = world.createTransformEntity();
  mainMenu.object3D!.name = "MainMenu";
  mainMenu.addComponent(PanelUI, {
    config: "./ui/main-menu.json",
    maxHeight: 1.2,
    maxWidth: 1.2,
  });
  mainMenu.object3D!.position.set(0, 1.6, 0.5);

  // ── Register systems ──────────────────────────────────────────────────────
  world.registerSystem(HandwheelSystem);
  world.registerSystem(DoorSystem);
  world.registerSystem(MainMenuSystem);
});
