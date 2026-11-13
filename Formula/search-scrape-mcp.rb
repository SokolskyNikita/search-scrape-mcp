# Homebrew formula for search-scrape-mcp. This repository is its own tap:
#
#   brew tap sokolskynikita/search-scrape https://github.com/SokolskyNikita/search-scrape-mcp
#   brew install search-scrape-mcp
#
# scripts/release.sh updates the tag and revision below; don't edit them by hand.
class SearchScrapeMcp < Formula
  desc "Local MCP server giving AI agents web search, scraping and a remote browser"
  homepage "https://github.com/SokolskyNikita/search-scrape-mcp"
  url "https://github.com/SokolskyNikita/search-scrape-mcp.git",
      tag:      "v2.0.5",
      revision: "35f4add96be1dfbd5af6620ad95dc3887364344a"
  license "MIT"
  head "https://github.com/SokolskyNikita/search-scrape-mcp.git", branch: "main"

  depends_on :macos
  depends_on "node"
  depends_on "yt-dlp"

  def install
    # Install exactly the dependency versions in package-lock.json, then drop the build-only ones.
    system "npm", "ci"
    system "npm", "run", "build"
    system "npm", "prune", "--omit=dev"
    libexec.install "dist", "node_modules", "package.json"
    (libexec/"src/providers").install "src/providers/yt-dlp.py"
    chmod 0755, libexec/"dist/cli/main.js"
    env = {
      PATH:                      "#{formula_opt_bin("node")}:${PATH}",
      SEARCH_SCRAPE_MCP_COMMAND: HOMEBREW_PREFIX/"bin/search-scrape-mcp",
    }
    (bin/"search-scrape-mcp").write_env_script libexec/"dist/cli/main.js", env
  end

  def caveats
    <<~EOS
      Finish setting up (saves your Serper and Scrapfly keys, starts the server, connects
      Claude Code and Codex, and checks everything):
        search-scrape-mcp setup

      Later, get new versions with:
        search-scrape-mcp update
    EOS
  end

  test do
    assert_match "search-scrape-mcp #{version}", shell_output("#{bin}/search-scrape-mcp --version")
  end
end
