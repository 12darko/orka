---
name: unity
description: Unity projects (C# scripts, scenes, prefabs, ScriptableObjects, packages). Use for any gameplay, UI, editor-tooling or build work in a folder with Assets/ and ProjectSettings/.
---

# Unity

## Orient first
- Confirm the Unity version in `ProjectSettings/ProjectVersion.txt` and the render pipeline / packages in `Packages/manifest.json` (URP/HDRP, Input System, Netcode, Addressables, UniTask, DOTween...). Use the APIs of that version and those packages.
- Find existing conventions before adding code: folder layout under `Assets/`, assembly definitions (`*.asmdef`), namespaces, event systems, singletons/service locators, dependency injection (Zenject/VContainer).
- Never touch `Library/`, `Temp/`, `Logs/`, `obj/`, `UserSettings/`. Never edit `.meta` files by hand except to keep a GUID when moving a file.

## Writing scripts
- One `MonoBehaviour`/`ScriptableObject` per file, file name == class name (Unity requires it to attach the script).
- Serialize with `[SerializeField] private` fields, not public fields. Use `[Header]`, `[Tooltip]`, `[Range]` for inspector clarity. Add `[RequireComponent]` when a component depends on another.
- Cache component lookups (`GetComponent` in `Awake`), never in `Update`. Avoid `Find*`, `GameObject.Find`, LINQ and allocations in per-frame code.
- Lifecycle: `Awake` for self-setup, `OnEnable`/`OnDisable` for subscribe/unsubscribe (always unsubscribe), `Start` for cross-object setup.
- Physics in `FixedUpdate` with `Rigidbody` APIs; input and visuals in `Update`. Use `Time.deltaTime` / `Time.fixedDeltaTime` correctly.
- Prefer events/C# actions or ScriptableObject channels over tight references between systems. Keep MonoBehaviours thin; put logic in plain C# classes you can test.
- Async: follow the project (coroutines, `async`/`Awaitable` in Unity 6, or UniTask). Stop coroutines/cancel tokens on disable/destroy.
- Null checks on `UnityEngine.Object` use `== null` / `if (obj)`, not `?.` or `??` (they bypass Unity's lifetime check).
- Editor-only code goes in an `Editor/` folder or behind `#if UNITY_EDITOR`.

## Scenes, prefabs and assets
- Scene and prefab YAML is fragile: prefer changing scripts and asking the user to wire references in the editor. If you must edit YAML, change only the specific property and keep fileIDs/GUIDs intact.
- Tell the user exactly which inspector fields to assign after adding serialized fields.

## Verify
- There is usually no command-line compile in the loop. Check C# carefully: matching braces, `using` directives, namespaces, access modifiers, and that every referenced type exists (search for it).
- If `*.csproj` / `*.sln` files exist, `dotnet build` on the solution can catch compile errors (it may fail on Unity-specific references; say so if it does).
- For tests use the Unity Test Framework (EditMode/PlayMode, `[Test]`, `[UnityTest]`) and tell the user how to run them if you cannot.
- Finish with what the user must do in the editor (assign references, add components, rebuild Addressables, etc.).
