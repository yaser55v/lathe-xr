
import {
  createComponent,
  createSystem,
  Types,
  Pressed,
  Vector3
} from "@iwsdk/core";

export const Door = createComponent("Door", {
  isOpen: { type: Types.Boolean, default: false },
  openProgress: { type: Types.Float32, default: 0 },
  slideAxis: { type: Types.Vec3, default: [-1, 0, 0] }, // "Right to Left"
  slideDistance: { type: Types.Float32, default: 0.75 }, // 75cm slide
});

export class DoorSystem extends createSystem({
  doors: { required: [Door] },
  pressed: { required: [Door, Pressed] },
}) {
  // Store initial positions for both the hitbox and the actual GLTF mesh
  private hitboxInitPos: WeakMap<any, Vector3> = new WeakMap();
  private meshInitPos: WeakMap<any, Vector3> = new WeakMap();

  init() {
    // Toggle door state on click
    this.queries.pressed.subscribe("qualify", (entity) => {
      const current = entity.getValue(Door, "isOpen") ?? false;
      entity.setValue(Door, "isOpen", !current);
    });
  }

  update(delta: number) {
    for (const entity of this.queries.doors.entities) {
      const isOpen = entity.getValue(Door, "isOpen") ?? false;
      let progress = entity.getValue(Door, "openProgress") ?? 0;
      
      const target = isOpen ? 1 : 0;
      if (Math.abs(progress - target) > 0.001 || progress !== target) {
        progress = moveToward(progress, target, delta * 2.5);
        entity.setValue(Door, "openProgress", progress);
        
        const axisArr = (entity as any).getVectorView(Door, "slideAxis");
        const distance = entity.getValue(Door, "slideDistance") ?? 0.75;
        const axis = new Vector3(axisArr[0], axisArr[1], axisArr[2]);
        
        const hitbox = entity.object3D!;
        const doorMesh = hitbox.userData.doorObject;

        if (doorMesh) {
          // Cache initial positions once
          if (!this.hitboxInitPos.has(entity)) {
            this.hitboxInitPos.set(entity, hitbox.position.clone());
            this.meshInitPos.set(entity, doorMesh.position.clone());
          }

          const hPos = this.hitboxInitPos.get(entity)!;
          const mPos = this.meshInitPos.get(entity)!;

          // Apply displacement to both so the hitbox stays on the door
          const displacement = axis.clone().multiplyScalar(progress * distance);
          hitbox.position.copy(hPos).add(displacement);
          doorMesh.position.copy(mPos).add(displacement);
        }
      }
    }
  }
}

function moveToward(current: number, target: number, step: number): number {
  if (current === target) return current;
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}
