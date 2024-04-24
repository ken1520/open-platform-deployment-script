require('dotenv').config()
const axios = require("axios");
const _ = require("lodash");
const simpleGit = require("simple-git");
const JiraClient = require("jira-client");

const RELEASE_ACTIONS = ["check", "release_branch", "release_pr"];

const releaseAction = process.argv[2];

if (!RELEASE_ACTIONS.includes(releaseAction)) {
  console.error(`Invalid action "${releaseAction}"!`);
  return;
}

const releaseVersion = process.argv[3];

const releaseBranchName = `release/${releaseVersion}`;

// List of repos deployed by Open Platform
const WHITELISTED_REPOS = [
  "developer-api",
  "developer-center",
  "developer-oauth",
  "developer-event",
  "mini-app-store",
  "sub9-api",
  "metafield-api",
  "multipass-api",
  "merchant-event-serializer",
  "storefront-api",
  // Add more repositories if needed
];

// Local directory of repositories
const REPO_BASE_PATH = `${process.env.HOME}/Documents/`; //TODO: replace your own path

// Bitbucket API info and credentials
const BITBUCKET_WORKSPACE = "starlinglabs";
const BITBUCKET_USERNAME = process.env.BITBUCKET_USERNAME;
const BITBUCKET_PASSWORD = process.env.BITBUCKET_PASSWORD;
const BITBUCKET_API_URL = `https://api.bitbucket.org/2.0/repositories/${BITBUCKET_WORKSPACE}/REPO_SLUG/`;

// Bitbucket create release PR API request data
const BITBUCKET_API_CREATE_PR_REQUEST_DATA = {
  title: `Release ${releaseVersion}`,
  description: "",
  source: {
    branch: {
      name: releaseBranchName,
    },
  },
  destination: {
    branch: {
      name: "master",
    },
  },
};

// Jira API credentials
const JIRA_BASE_URL = "shopline.atlassian.net";
const JIRA_USERNAME = process.env.JIRA_USERNAME;
const JIRA_API_TOKEN = process.env.JIRA_API_TOKEN;

// Create a new JiraClient instance
const jira = new JiraClient({
  protocol: "https",
  host: JIRA_BASE_URL,
  username: JIRA_USERNAME,
  password: JIRA_API_TOKEN,
  apiVersion: "2",
});

// Only override intermediatePath for genericGet
const jiraForGenericGet = new JiraClient({
  protocol: "https",
  host: JIRA_BASE_URL,
  username: JIRA_USERNAME,
  password: JIRA_API_TOKEN,
  apiVersion: "2",
  intermediatePath: "/rest",
});

// Get PRs by Jira issue id
const getPRsFromJira = (issueId) => {
  return jiraForGenericGet.genericGet(
    `/dev-status/latest/issue/detail?issueId=${issueId}&applicationType=bitbucket&dataType=pullrequest`,
  );
};

// Get Jira card info from a release
const getJiraCardsFromRelease = async () => {
  try {
    const jql = `project = DC AND fixVersion = "${releaseVersion}"`;
    return await jira.searchJira(jql);
  } catch (error) {
    console.error(
      "Error retrieving Jira cards from the release:",
      error.message,
    );
  }
};

// Get all repos from a release
const getReposFromRelease = async (release) => {
  let repos = [];
  for (var i = 0; i < release.issues.length; i++) {
    const issue = release.issues[i];
    const issueKey = issue.key;

    const detail = await getPRsFromJira(issue.id);
    const pullRequests = detail.detail[0].pullRequests;

    repos.push(..._.uniq(pullRequests.map((p) => p.repositoryName)));
  }

  return _.uniq(repos);
};

/********************\
 * Deployment Check *
\********************/

// Call the function to get Jira card info from a release
const displayReleaseDetails = async () => {
  const jiraRes = await getJiraCardsFromRelease();

  const table = {};
  for (var i = 0; i < jiraRes.issues.length; i++) {
    const issue = jiraRes.issues[i];
    const issueKey = issue.key;

    const detail = await getPRsFromJira(issue.id);
    const pullRequests = detail.detail[0].pullRequests;

    table[issueKey] = {};
    table[issueKey]["Summary"] = issue.fields.summary;
    table[issueKey]["Status"] = issue.fields.status.name;
    table[issueKey]["Repo"] = _.uniq(
      pullRequests.map((p) => p.repositoryName),
    ).join(",");
    table[issueKey]["Author(s)"] = _.uniq(
      pullRequests.map((p) => p.author.name),
    ).join(",");
    table[issueKey]["Linked issues"] = _.uniq(
      issue.fields["issuelinks"].map((p) =>
        p.inwardIssue ? p.inwardIssue.key : p.outwardIssue.key,
      ),
    ).join(",");
    table[issueKey]["Deployment remarks"] = issue.fields["customfield_10041"];
  }

  console.table(table);
};

/***************************\
 * Create Release Branches *
\***************************/

// Check if there are any uncommitted changes and stash them if necessary
const stashChangesIfNeeded = async (git) => {
  const status = await git.status();
  if (!status.isClean()) {
    console.log("Stashing uncommitted changes...");
    await git.stash();
  }
};

const checkoutBranch = async (repository, branchName) => {
  const repositoryPath = REPO_BASE_PATH + repository;

  const git = simpleGit({ baseDir: repositoryPath });

  // Check if there are any uncommitted changes and stash them if necessary
  await stashChangesIfNeeded(git);

  await git.fetch();

  await git.checkout("dev");

  await git.pull();

  await git.checkoutLocalBranch(branchName);

  await git.push("origin", branchName);
};

// Create release git branch release/xxx
const createReleaseBranches = async () => {
  const jiraRes = await getJiraCardsFromRelease();
  let releaseRepos = await getReposFromRelease(jiraRes);

  for (const repository of releaseRepos) {
    if (WHITELISTED_REPOS.includes(repository)) {
      console.log(
        `[-] Creating release branch '${releaseBranchName}' in repository '${repository}'...`,
      );
      try {
        await checkoutBranch(repository, releaseBranchName);
        console.log(
          `[O] Successfully created release branch for repository '${repository}'`,
        );
      } catch (error) {
        console.error(
          `[X] Error occured when creating release branch for repository '${repository}':`,
          error,
        );
      }
    } else {
      console.log(
        `[!] ${repository} should not be deployed by Open Platform, skip creating release branch`,
      );
    }
    console.log();
  }
};

/**********************\
 * Create Release PRs *
\**********************/

// Call Bitbucket API to create PR, i.e. release/xxx --> master
const createBitbucketPr = async (repo) => {
  const apiUrl = BITBUCKET_API_URL.replace("REPO_SLUG", repo) + "pullrequests";
  res = await axios.post(apiUrl, BITBUCKET_API_CREATE_PR_REQUEST_DATA, {
    auth: { username: BITBUCKET_USERNAME, password: BITBUCKET_PASSWORD },
  });
};

// Create release PRs for each repo in a relase
const createReleasePRs = async () => {
  const jiraRes = await getJiraCardsFromRelease();
  let releaseRepos = await getReposFromRelease(jiraRes);

  for (const repository of releaseRepos) {
    if (WHITELISTED_REPOS.includes(repository)) {
      console.log(`[-] Creating release PR for repository '${repository}'...`);
      try {
        await createBitbucketPr(repository);
        console.log(
          `[O] Successfully create release PR for repository '${repository}'`,
        );
      } catch (error) {
        console.error(
          `[X] Error occured when creating release PR for repository '${repository}':`,
          error,
        );
      }
    } else {
      console.log(
        `[!] ${repository} should not be deployed by Open Platform, skip creating release PR`,
      );
    }
    console.log();
  }
};

/****************\
 * Main Control *
\****************/
switch (releaseAction) {
  case "check":
    displayReleaseDetails();
    break;

  case "release_branch":
    createReleaseBranches();
    break;

  case "release_pr":
    createReleasePRs();
    break;
}
