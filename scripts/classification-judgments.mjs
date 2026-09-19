// Judgment specifications for repository facet classification.
//
// The regex classifier in update-trending.mjs matches keywords over
// slug + description + language + topics. That makes a bare `ai` topic enough to
// tag a Postgres platform or an S3 object store as `ai-ml`, and leaves a repository
// with no topics and no literal keyword `unclassified`. These specs replace each
// keyword rule with one TypeSafe Noul: "does this tag hold for this repository",
// answered from the repository's own text rather than from topic vocabulary.
//
// One Noul per tag, because several tags legitimately apply at once. The criteria
// carry the exclusions the regex cannot express: carrying a topic, depending on a
// library, or integrating with a tool is not the same as being about that subject.
//
// This module is the question design and the answer composition only. The transport
// (HTTP API or SDK) is deliberately not implemented here.

export const TAG_RULE_VERSION = 2;

// Declaration order is canonical: hasCanonicalTags() in update-trending.mjs requires
// emitted tags to appear in this order, so resolveTags() must preserve it.
export const FIELD_JUDGMENTS = [
  {
    id: "ai-ml",
    instructions: "Decide whether artificial intelligence or machine learning is the subject of this repository — what it is built to do — rather than an implementation detail, a dependency, or a listed topic.",
    criteria: {
      yes: "The repository's own purpose is AI or ML: models, training, inference, agents, LLM tooling, embeddings, computer vision, or NLP. A tool whose reason to exist is to build, run, evaluate, or orchestrate AI counts.",
      no: "AI or ML is incidental. The repository carries an `ai`-like topic, ships an optional AI feature, embeds vectors as one storage type among many, or is merely usable by an AI agent, while its actual subject is something else such as storage, databases, or diagrams.",
    },
  },
  {
    id: "web-app",
    instructions: "Decide whether this repository is for building or running web or mobile client applications.",
    criteria: {
      yes: "Its subject is web or mobile application development: browser front-ends, UI frameworks and component libraries, web or mobile apps, or browser extensions.",
      no: "It is backend, infrastructure, or general-purpose software that merely happens to be written in a web language or to expose an HTTP interface.",
    },
  },
  {
    id: "dev-tools",
    instructions: "Decide whether this repository is tooling whose users are software developers working on code.",
    criteria: {
      yes: "It exists to support the act of building software: editors, compilers, linters, debuggers, SDKs, code review and code generation tools, build tooling, or developer CLIs.",
      no: "Its users are not developers acting as developers, or it is an end-user product, a runtime service, or a learning resource that happens to be about programming.",
    },
  },
  {
    id: "data",
    instructions: "Decide whether storing, querying, moving, or analysing data is the subject of this repository.",
    criteria: {
      yes: "Its subject is data itself: databases and storage engines, query engines, data pipelines and warehouses, analytics, or object and file storage systems.",
      no: "It merely persists its own state, reads a config file, or depends on a database to do something else.",
    },
  },
  {
    id: "devops",
    instructions: "Decide whether this repository is about operating, deploying, or observing software in production.",
    criteria: {
      yes: "Its subject is infrastructure and operations: containers and orchestration, CI/CD, provisioning, cloud platform tooling, monitoring, logging, or observability.",
      no: "It ships a Dockerfile or a CI config for its own development, which every project does, and is otherwise about something else.",
    },
  },
  {
    id: "security",
    instructions: "Decide whether security or privacy is the subject of this repository.",
    criteria: {
      yes: "Its subject is protecting systems or people: vulnerability discovery, penetration testing, auditing, cryptography, secret management, authentication and authorization systems, or privacy-preserving tooling.",
      no: "It states that it is secure, handles credentials as part of ordinary operation, or lists a `privacy` topic, while its purpose lies elsewhere.",
    },
  },
  {
    id: "productivity",
    instructions: "Decide whether this repository is an application that helps people get personal or professional work done.",
    criteria: {
      yes: "It is an end-user product for knowledge or personal work: note-taking, knowledge management, task and project management, communication, finance, media, or desktop productivity applications.",
      no: "Its users are developers acting as developers, or it is a library, an infrastructure component, or a learning resource.",
    },
  },
  {
    id: "systems",
    instructions: "Decide whether this repository concerns low-level systems, operating systems, or physical hardware.",
    criteria: {
      yes: "Its subject is operating systems and kernels, drivers, embedded or firmware development, robotics, hardware, or on-device and smart-home systems.",
      no: "It is written in a systems language such as Rust, C, or Go but is an ordinary application, service, or library.",
    },
  },
  {
    id: "learning",
    instructions: "Decide whether this repository exists mainly to teach a subject or to collect resources for learning it, rather than to be run as working software.",
    criteria: {
      yes: "Its value to a reader is educational: tutorials, courses, books, curricula, interview or study preparation, `awesome`-style curated resource lists, or software whose stated purpose is helping people learn and memorise.",
      no: "It is working software that happens to have good documentation or an examples directory.",
    },
  },
];

export const FORM_JUDGMENTS = [
  {
    id: "agent",
    instructions: "Decide whether this repository is, or exists to build and run, an autonomous or semi-autonomous AI agent that plans and takes actions across multiple steps.",
    criteria: {
      yes: "It is an agent, an agent harness, or an agent framework: something that decides on and executes a sequence of actions toward a goal.",
      no: "It is a single-turn AI feature, a model wrapper, or a tool an agent can call. Being designed for use *by* an agent does not make a repository an agent.",
    },
  },
  {
    id: "mcp",
    instructions: "Decide whether this repository implements the Model Context Protocol — an MCP server, an MCP client, or MCP-specific tooling.",
    criteria: {
      yes: "MCP is part of what it ships: it serves, consumes, proxies, or provides tooling for the protocol.",
      no: "MCP appears only as a listed topic, a roadmap item, or a passing mention, and nothing in the repository implements it.",
    },
  },
  {
    id: "plugin-skill",
    instructions: "Decide whether this repository is distributed as a plugin, extension, or skill that loads into a host application rather than running on its own.",
    criteria: {
      yes: "It is packaged to extend a host: an agent skill, an editor or browser extension, or a plugin for another product. It needs that host to do anything.",
      no: "It is a standalone program, service, or library, even if it happens to support a plugin system of its own.",
    },
  },
  {
    id: "ide",
    instructions: "Decide whether this repository is an integrated development environment, a code editor, or a full coding workspace.",
    criteria: {
      yes: "It provides the environment a developer writes code in: an editor, an IDE, or a hosted or containerised development workspace.",
      no: "It is a plugin or extension *for* an editor, or a command-line tool used alongside one.",
    },
  },
  {
    id: "library",
    instructions: "Decide whether this repository is distributed primarily as a library, SDK, or package that other software imports.",
    criteria: {
      yes: "Its intended use is being depended on in someone else's codebase and called from their code.",
      no: "Its intended use is being run — as an application, a service, or a command-line tool — even when it also publishes a package.",
    },
  },
  {
    id: "framework",
    instructions: "Decide whether this repository is a framework: it defines the structure of the application built with it and calls the user's code.",
    criteria: {
      yes: "Users build inside it, following its lifecycle, conventions, and extension points.",
      no: "Users call it from code they structure themselves, which makes it a library rather than a framework.",
    },
  },
  {
    id: "cli",
    instructions: "Decide whether this repository's primary interface is a command-line program the user runs in a terminal.",
    criteria: {
      yes: "The command line is how it is mainly used, including terminal user interfaces.",
      no: "Its primary interface is a graphical or web UI, a library API, or a long-running service, even when a helper command exists for setup or administration.",
    },
  },
];

export const FIELD_TAG_IDS = FIELD_JUDGMENTS.map(judgment => judgment.id);
export const FORM_TAG_IDS = FORM_JUDGMENTS.map(judgment => judgment.id);

const README_EXCERPT_LIMIT = 4000;

// The regex classifier never reads the README. The refresh pipeline has already
// fetched and verified one by this point, so the judgments get it as state.
export function buildClassificationState({ slug, description, primary_language, topics, readme } = {}) {
  if (typeof slug !== "string" || !slug) throw new Error("classification state requires a slug");
  if (!Array.isArray(topics)) throw new Error("classification state requires a topics array");
  return {
    repository: {
      slug,
      description: typeof description === "string" && description ? description : null,
      primary_language: typeof primary_language === "string" && primary_language ? primary_language : null,
      topics: [...topics],
      readme_excerpt: typeof readme === "string" && readme ? readme.slice(0, README_EXCERPT_LIMIT) : null,
    },
  };
}

export function buildClassificationQuestions() {
  return [...FIELD_JUDGMENTS, ...FORM_JUDGMENTS].map(judgment => ({
    id: judgment.id,
    type: "noul",
    instructions: judgment.instructions,
    criteria: judgment.criteria,
  }));
}

// Thresholds are a policy decision held in code, kept separate from the raw
// probabilities so they can be retuned without rerunning inference.
export const DEFAULT_TAG_THRESHOLD = 0.5;

export function resolveTags(answers, { threshold = DEFAULT_TAG_THRESHOLD } = {}) {
  if (!answers || typeof answers !== "object") throw new Error("answers must be an object keyed by question id");
  if (!(threshold > 0 && threshold < 1)) throw new Error("threshold must be between 0 and 1");
  const held = ids => ids.filter(id => {
    const probability = answers[id];
    if (typeof probability !== "number" || !Number.isFinite(probability) || probability < 0 || probability > 1) {
      throw new Error(`missing or invalid probability for ${id}`);
    }
    return probability >= threshold;
  });
  const field_tags = held(FIELD_TAG_IDS);
  return {
    tag_rule_version: TAG_RULE_VERSION,
    field_tags: field_tags.length ? field_tags : ["unclassified"],
    form_tags: held(FORM_TAG_IDS),
  };
}
