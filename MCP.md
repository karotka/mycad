# MyCAD MCP server

MyCAD includes a local Model Context Protocol server for agent-driven CAD work. By default it connects to the currently open Electron window: reads reflect the visible drawing, modelling changes use its normal Undo/Redo history, and the viewport redraws immediately.

The bridge listens only on `127.0.0.1`, chooses an ephemeral port and requires a random secret from a user-specific mode-0600 discovery file. The stdio MCP process never exposes a network port beyond the local machine.

## Connect to the open window

Start MyCAD first, then use this client configuration:

```json
{
  "mcpServers": {
    "mycad": {
      "command": "npm",
      "args": ["run", "--silent", "mcp"],
      "cwd": "/Users/zphilipp/git/mycad"
    }
  }
}
```

Running `npm run mcp` directly uses the same desktop mode. If MyCAD is not open, tool calls return a clear connection error instead of silently editing another document.

## Optional headless mode

For automation without the desktop application:

```sh
npm run mcp -- --headless
npm run mcp -- --headless --project /absolute/path/to/model.mycad
```

Headless mode owns a separate in-memory document. Saving it explicitly is required before opening the result in MyCAD.

## Available operations

- Inspect the document, current selection, objects, active UCS and Undo/Redo state.
- Read a solid's real geometry with `describe_solid` — planar faces (world-space outline plus holes) and circular edges (hole/rim centres and radii), so a part can be measured without exporting STL.
- Move, rotate and scale solids in place with `transform_solids`, keeping their recipe.
- Push or pull a planar face (`press_pull`), round or bevel an edge (`fillet_edge` / `chamfer_edge`, edge given by its two endpoints), and cut a solid with a plane (`slice_solid`).
- Set the UCS from three points (`set_ucs`) or return to the world (`restore_wcs`).
- Manage layers: `create_layer`, `set_current_layer`, and move objects with `set_object_layer`.
- Create boxes, wedges, spheres, cones, cylinders, pyramids and tori in the active UCS.
- Create batches of 3D line segments between points in the active UCS.
- Extrude a closed profile into a solid: an existing closed entity by `profileId`, or a `points` outline traced in the active UCS. The height is signed (negative extrudes downward) and outline points may carry a z, so a profile traced at a height extrudes from that height.
- Union solids or subtract several cutters from one base solid.
- Remove a feature from an oriented surface point.
- Select or delete objects, undo and redo modelling edits.
- Open and save `.mycad` projects.
- Export explicit or currently selected solids to ASCII STL.

Coordinates and dimensions use millimetres. `delete_feature` expects a point and outward surface normal in world coordinates; this makes the operation unambiguous on nested holes, fillets and chamfers.
