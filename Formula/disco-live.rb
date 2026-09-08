class DiscoLive < Formula
  desc "Team command center for all things agentic"
  homepage "https://disco.live"
  url "https://registry.npmjs.org/disco-live/-/disco-live-0.21.0.tgz"
  sha256 "26c4ffb68c09b511349ee975c9e97605d21cfed8a130e95827c54de433ac08f7"
  license "BUSL-1.1"

  depends_on "node@24"

  def install
    node = Formula["node@24"]

    (libexec/"lib").mkpath
    system node.opt_bin/"npm", "install", "--loglevel=silly", "--global",
           "--min-release-age=1", "--cache=#{HOMEBREW_CACHE}/npm_cache",
           "--prefix=#{libexec}", cached_download
    prune_native_prebuilds
    (bin/"disco").write_env_script libexec/"bin/disco", PATH: "#{node.opt_bin}:$PATH"
    (bin/"disco-daemon").write_env_script libexec/"bin/disco-daemon", PATH: "#{node.opt_bin}:$PATH"
  end

  test do
    assert_match "Team command center", shell_output("#{bin}/disco --help")
  end

  private

  def prune_native_prebuilds
    node_modules = libexec/"lib/node_modules/disco-live/node_modules"
    platform = OS.mac? ? "darwin" : "linux"
    arch = Hardware::CPU.arm? ? "arm64" : "x64"
    current_platform = "#{platform}-#{arch}"

    Pathname.glob(node_modules/"**/prebuilds/*")
            .select(&:directory?)
            .reject { |path| path.basename.to_s == current_platform }
            .each { |path| rm_r path }

    ripgrep_bin = node_modules/"@github/copilot/ripgrep/bin"
    if ripgrep_bin.directory?
      ripgrep_bin.children
                 .reject { |path| path.basename.to_s == current_platform }
                 .each { |path| rm_r path }
    end

    mxc_bin = node_modules/"@github/copilot/mxc-bin"
    if mxc_bin.directory?
      mxc_bin.children
             .reject { |path| path.basename.to_s == arch }
             .each { |path| rm_r path }
    end

    clipboard_root = node_modules/"@github/copilot/clipboard/node_modules/@teddyzhu"
    if clipboard_root.directory?
      clipboard_tokens = [current_platform, "#{current_platform}-gnu"]
      clipboard_root.glob("clipboard-*")
                    .reject { |path| clipboard_tokens.any? { |token| path.basename.to_s.include?(token) } }
                    .each { |path| rm_r path }
      clipboard_files = (clipboard_root/"clipboard").glob("clipboard.*.node")
      clipboard_files.reject { |path| clipboard_tokens.any? { |token| path.basename.to_s.include?(token) } }
                     .each { |path| rm_r path }
    end
  end
end
