# エージェント向けガイド

## worktreeで作業を分ける

複数のエージェントが同時に作業するため、作業ごとに専用のgit worktreeを使います。1作業 = 1 worktree = 1ブランチ = 1 PR です。

- メインのチェックアウト（`gamejam/`）は `main` のままにし、ファイルを編集しません。
- 作業を始める前に、`main` から兄弟ディレクトリへworktreeを作ります。

  ```sh
  git fetch origin
  git worktree add -b <branch> ../gamejam-<topic> origin/main
  cd ../gamejam-<topic> && npm ci
  ```

- すでにその作業用のworktreeがあれば、それを使い続けます。`git worktree list` で確認できます。
- 他の作業のworktreeやブランチは編集しません。
- コミット・PRはそのworktreeの中で行います。PRがマージされたら `git worktree remove ../gamejam-<topic>` で片付けます。
